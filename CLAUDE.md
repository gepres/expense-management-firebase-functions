# CLAUDE.md — Guía operativa para Claude Code

Este archivo orienta a futuras sesiones de Claude Code dentro de **gastos-firebase-functions**. Leerlo antes de tocar código o documentación.

## 1. ¿Qué es este proyecto?

Asistente de gastos por WhatsApp. `twilioWebhook` (HTTPS, valida `X-Twilio-Signature`) recibe el mensaje y lo encola en `whatsapp_queue`; `processWhatsAppQueue` (`onDocumentCreated`) lo procesa (texto, imagen o audio), infiere categoría/método/moneda/cuenta y guarda el gasto en `expenses`. Responde por WhatsApp vía Twilio. El "Phase 1" externo ya está absorbido en este repo.

> **Ingestión activa (desde 2026-05-15):** Twilio apunta a `twilioWebhook` de este repo en producción (`https://us-central1-expense-app-gepres.cloudfunctions.net/twilioWebhook`, 2ª gen). El webhook NestJS/Vercel (`gastos-backend` `POST /api/whatsapp/webhook`) queda como **rollback** sin tráfico y **sin** validación de firma. Caveat: `twilioWebhook` encola con `.add()` (ID autogenerado) → un reintento de Twilio crea 2 docs en la cola; el gasto NO se duplica (idempotencia por `messageSid` en `finalizeAndRegisterExpense`). Fuente cruzada: `gastos-backend/WHATSAPP_FLOW.md`.

- Runtime: **Node 22**, **Firebase Functions v2** (`firebase-functions@^6.6.0`; `onDocumentCreated`/`onRequest`), **TypeScript 5.3** (strict). Node 20 quedó deprecado (decomisión 2026-10-30); el runtime sale de `package.json` `engines.node`. firebase-functions v7 es un major aún no migrado.
- NLU: **Anthropic Claude `claude-sonnet-4-20250514`** (texto + Vision).
- Audio: **OpenAI Whisper (`whisper-1`)**, idioma `es`.
- Mensajería: **Twilio WhatsApp**.

## 2. Mapa del código

```
src/index.ts                          ← funciones (twilioWebhook, processWhatsAppQueue, exportExpenses, healthCheck) + finalizeAndRegisterExpense + comandos
src/types/index.ts                    ← interfaces compartidas (incl. Account, Movement, LearningLog, BotCommand)
src/services/
  anthropic.service.ts                ← parseExpenseMessage + extractReceiptData (Vision)
  transcription.service.ts            ← Whisper, escribe a tmpfile y limpia
  inference.service.ts                ← classify() + resolvePaymentMethod + resolveCurrency + inferVoucherType
  expense.service.ts                  ← saveExpense (solo expense) + getPending/getById/findByMessageSid/summary + getSummaryBetween/getExpensesBetween (consultas)
  account.service.ts                  ← cuenta activa (canónica) + listCanonical + NoCanonicalAccountError + sesión wsp
  learning-log.service.ts             ← bitácora de decisiones por usuario (queryRelevant/append/feedback)
  onboarding.service.ts               ← marca primer contacto (idempotente) para el onboarding auto
  user.service.ts                     ← lookup por whatsappPhone
  twilio.service.ts                   ← sendMessage
src/config/
  models.ts                           ← resuelve modelo + thinking/effort por tier (modelParams/transcribeModel)
  help.ts                             ← FUENTE ÚNICA de ayuda/onboarding (menú + temas + bienvenida)
src/utils/
  message-parser.ts                   ← normalizeForMatching, validateAmount, parseDateFromText, parsers de comandos
  media-downloader.ts                 ← descarga media de Twilio con basic auth
  media-types.ts                      ← fuente única de tipos de media (audio/imagen)
  twilio-webhook.ts                   ← validación X-Twilio-Signature + mapper a queue doc
  csv.ts                              ← serializador CSV (RFC 4180) para exportExpenses
src/scripts/
  backfill-accounts.ts                ← migración idempotente: accountId en expenses históricos
```

Punto de entrada lógico: `processWhatsAppQueue` en `src/index.ts`. Toda registración de gasto (texto/imagen/audio) converge en `finalizeAndRegisterExpense`.

## 3. Convenciones del repo

- **Idioma de los mensajes/UX:** español (Perú). Soles, Yape, Plin, "bodega", etc.
- **Ayuda/onboarding:** fuente única en `src/config/help.ts` (`HELP_TOPICS`). El menú (`ayuda`), los temas (`ayuda <clave>`) y la bienvenida se generan de ahí. Al agregar un flujo nuevo, añadir/editar su entrada en `HELP_TOPICS` (aparece solo en el menú) — **no** hardcodear textos de comandos en `index.ts`. Onboarding automático en el 1er contacto tras vincular WhatsApp vía `OnboardingService.tryClaimFirstContact` (idempotente; guard: si ya hay `learning_log` no se saluda — usuario previo a la feature). Cada mensaje debe caber en ~1600 chars (límite WhatsApp); hay tests que lo verifican.
- **Identidad del gasto:** vinculado por `userId` + `accountId`, **no** por `phoneNumber`. El teléfono solo resuelve al usuario.
- **Cuenta activa:** todo gasto va a una cuenta (`AccountService.resolveActiveAccount`: sesión wsp → primary → primera → crea "Principal" lazy). Sin `accountId`, `saveExpense` rechaza.
- **Saldo (Opción A — desacople):** el web app/backend es **dueño único** del saldo y del ledger. Este bot **NO** gestiona saldo ni `movements`: `saveExpense` solo escribe el `expense` contra la cuenta canónica (NO transacción con movement/saldo — el invariante viejo de `db.runTransaction()` quedó obsoleto). `resolveActiveAccount` resuelve desde la colección **canónica top-level `accounts`** (`saldo` derivado = `bankBalance + cashBalance`, solo lectura). Comandos `saldo`/`saldos` = lectura canónica (`AccountService.listCanonical`, NO `listByUser` legacy). `ingreso`/`transferir`/`movimientos` se **retiraron del bot** (responden derivando a la app) — no reintroducir escritura de ledger aquí. `MovementService` y `users/{uid}/{accounts,movements}` legacy fueron eliminados/orfanados.
- **Nombres de campos en Firestore:** español (`monto`, `categoria`, `descripcion`, `fecha`, `metodoPago`, `moneda`, `voucherType`, `accountId`). Mantener consistencia.
- **Fechas:** `expense.fecha` se guarda como `Timestamp`. Prioridad de resolución: fecha en el texto (`MessageParser.parseDateFromText`) → fecha del mensaje (`whatsapp_queue.createdAt`) → ya **no** hay default `new Date()` del processing. `dateSource` queda persistido.
- **Clasificación (`InferenceService.classify`):** orden estricto `suggestions_ideas` → nombre subcategoría → nombre categoría → historial (`learning_log`, por solape de tokens `tokenOverlap` ≥ `MIN_HISTORY_OVERLAP`, prioriza `user_correction`) → **LLM acotado a la taxonomía** (paso 5: reusa el hint libre del LLM o `AnthropicService.classifyAgainstTaxonomy`, solo en miss de 1–4) → `sin_clasificar` (`needsClassification: true`). Pasos 1–3 match por **palabra/frase completa** (`phraseMatches`), nunca `includes` substring; el LLM (paso 5) nunca inventa categorías fuera de las del usuario. Devuelve `matchedTerm`/`matchedLevel` (`suggestion|subcategory|category|history|llm|default`) que se persisten para auditoría.
- **Moneda:** heredada de la cuenta activa salvo override explícito en texto (`resolveCurrency`). Defaults legacy `"otros"`/`"PEN"` ya no aplican a categoría/moneda.
- **Aprendizaje:** cada decisión se registra en `users/{uid}/learning_log`; las correcciones del usuario (`clasificar`) retroalimentan futuras clasificaciones.
- **Retry policy:** máximo 3 intentos. Tras el tercer fallo se marca `failed` y se notifica al usuario.
- **Logging:** `functions.logger.{info,warn,error}`. Emojis ya presentes en logs son intencionales para legibilidad — respetarlos al modificar.

## 4. Decisiones que ya están tomadas (no rediscutir sin pedirlo)

- Texto: **regex primero**, Anthropic como fallback. Es más barato y más rápido.
- Imágenes y audio: siempre van por modelo (no regex).
- **Functions v2** ya migrado. Trigger: `onDocumentCreated("whatsapp_queue/{queueId}", ...)`; `event.data` es el snapshot (guardar `if (!snap) return`), `event.params.queueId`.
- **Secrets via `defineSecret`** (`firebase-functions/params`), declarados en `index.ts` y bindeados a `processWhatsAppQueue` vía `secrets: [...]`. En runtime quedan como `process.env.<NAME>` — los services solo leen `process.env.*` (ya no hay `functions.config()`). Setear con `firebase functions:secrets:set <NAME>`.
- **Logging:** `import * as logger from "firebase-functions/logger"` (no `functions.logger`).

## 5. Antes de cambiar código

1. **Compilación:** `npm run build`. Bloquea el deploy si falla.
2. **Lint:** `npm run lint` (config: Google + TS plugin). Lint se ejecuta en `predeploy` (`firebase.json`).
3. **Emulador local:** `npm run serve` levanta solo Functions. Para probar manualmente, crear un doc en `whatsapp_queue` con `status: "pending"` y `retryCount: 0`.
4. **Tests:** `npm test` (runner nativo `node:test` sobre `lib/__tests__`, sin deps extra). Cubre lógica pura (`MessageParser`, `phraseMatches`, `tokenizeForLearning`). Se ejecuta en `predeploy`. Para lógica con Firestore, `firebase-functions-test` sigue disponible (sin uso aún).

## 6. Secretos y configuración

Cinco credenciales son necesarias:

| Variable                | Origen                        |
|-------------------------|-------------------------------|
| `TWILIO_ACCOUNT_SID`    | Twilio Console                |
| `TWILIO_AUTH_TOKEN`     | Twilio Console                |
| `TWILIO_WHATSAPP_NUMBER`| Twilio Sandbox o número productivo |
| `ANTHROPIC_API_KEY`     | console.anthropic.com         |
| `OPENAI_API_KEY`        | platform.openai.com (Whisper) |

Resolución: `defineSecret` en `index.ts` → bindeado a la función → `process.env.<NAME>` en runtime → leído por cada service. Configurar con `firebase functions:secrets:set <NAME>` (NO `functions:config:set`, que era v1). No hardcodear nunca.

**Localmente** `.env` solo cubre params no-secret: con `defineSecret` el emulador sondea Google Cloud Secret Manager y lanza 404/warning si los secrets no existen ahí. El override local correcto es **`.secret.local`** (formato `CLAVE=valor`, mismas 5 variables; está en `.gitignore`). Crearlo copiando los valores. Editarlo y reiniciar el emulador si cambia una clave. Los secrets **no** van en `.env` (rompe el deploy v2: "Secret environment variable overlaps non secret environment variable").

**Var no-secreta requerida en prod:** `TWILIO_WEBHOOK_URL` (en `.env`, bundled al deploy) = la URL **exacta** configurada en Twilio. Sin ella, en Cloud Run v2 la validación de firma falla siempre (el path se strip-ea, `req.url="/"`; ver §7 y `docs/SETUP.md` §9.1).

**Var no-secreta opcional:** `WEBAPP_URL` (en `.env`) — si está, se incluye en el mensaje guiado cuando el usuario no tiene cuenta canónica (dead-end de `resolveActiveAccount`). Si falta, el mensaje solo dice "créala en la app (sección Cuentas)" sin link.

**Modelos Anthropic por tier (no-secreto, opcional):** `ANTHROPIC_MODEL_PRIMARY` (vision + parse principal, default `claude-sonnet-4-6`) y `ANTHROPIC_MODEL_HELPER` (fallbacks acotados, default `claude-haiku-4-5`). Resueltos en `src/config/models.ts` vía `modelParams(tier)` — **único lugar** que decide modelo + `thinking`/`output_config`. Invariante: `output_config.effort` solo se manda si el modelo lo soporta (Sonnet 4.6+/Opus 4.5+); Haiku 4.5 y Sonnet ≤4.5 devuelven **400** con `effort`. Default conservador: modelo no reconocido → sin `effort`. Migrado desde `claude-sonnet-4-20250514` (deprecado, se retira 2026-06-15). Audio: `OPENAI_MODEL_TRANSCRIBE` (default `gpt-4o-mini-transcribe`, resuelto en `transcribeModel()` del mismo `models.ts`; OpenAI, no Claude — Whisper legacy reemplazado). Las 3 vars `*_MODEL_*` son no-secretas (`.env`, bundled); cambiar modelo no toca código pero sí requiere redeploy.

## 7. Trampas conocidas

- **Firestore rules/indexes NO se gestionan en este repo.** El proyecto Firebase `expense-app-gepres` es **compartido** con el web app `D:\PROYECTOS\gepres\gastos`, que es el **dueño único** de `firestore.rules` y `firestore.indexes.json`. Este repo ya **no** tiene esos archivos ni bloque `firestore` en `firebase.json` (un deploy desde aquí no puede tocar Firestore — protección tras un incidente: deployar las rules deny-all de este repo rompió el login del web app). Las queries del bot (`movements` `accountId`+`fecha`; `learning_log` `type`+`tokens`; `expenses` `userId`+`createdAt`/`fecha`/`needsClassification`/`needsReview`/`amountFlagged`) requieren índices que **ya están fusionados** en `gastos/firestore.indexes.json`. Para añadir/cambiar un índice o regla: editar y deployar **desde `D:\PROYECTOS\gepres\gastos`** (`firebase deploy --only firestore` allí), nunca desde aquí.
- **Migración previa al deploy:** correr `npm run backfill:accounts` una vez (idempotente). Sin `accountId` los expenses históricos no aparecen en queries por cuenta. El ledger arranca en cero (no se reproducen movements históricos) — el saldo real lo fija el usuario con `ingreso`/`ajustar`.
- **Idempotencia depende de `MessageSid`:** `finalize` salta duplicados solo si `webhookBody.MessageSid` está presente en el doc de `whatsapp_queue`. Si el Phase 1 externo no lo guarda, no hay protección anti-duplicado.
- **Firma de Twilio omitida en emulador:** el emulador sirve la función bajo `/<project>/<region>/<fn>` y strip-ea ese prefijo → `req.url` llega como `/`, así que la URL reconstruida nunca coincide con la que Twilio firmó (URL completa) → firma siempre inválida en local. `validateTwilioRequest` (`src/utils/twilio-webhook.ts`) retorna `true` si `process.env.FUNCTIONS_EMULATOR === "true"` (esa env solo existe en el emulador, jamás en prod; en prod Cloud Run sirve la fn en la raíz y la firma se valida normal). Es un bypass de auth gateado a local — al probar con WhatsApp real vía túnel se ve el warning `validación de firma OMITIDA (emulador)`. Ver `docs/SETUP.md` §8.1.
- **`extractReceiptData`** confía en que Anthropic devuelva JSON. Hay parseo defensivo de ```` ```json ```` pero un JSON malformado tira el flujo al `catch`. El retry lo cubre — ojo si cambias el prompt.
- **`AnthropicService.parseExpenseMessage`** aún retorna `voucherType: "boleta"` por defecto; `finalize` lo ignora y reinfiere con `inferVoucherType`. Ruido residual, no bug.
- **`getExpenseSummary` por mes:** ya arreglado (usa `Timestamp.fromDate` con cotas `[mes, mes+1)`).
- **`isValidAudioType` centralizado** en `src/utils/media-types.ts`. Añadir formatos en **un solo** lugar.
- **Mensaje sin texto y sin media:** se marca `completed` con `error: "No content to process"`. No responde al usuario; decisión consciente para no spamear.
- **Usuario sin cuenta canónica:** `resolveActiveAccount` lanza `NoCanonicalAccountError` (clase exportada de `account.service.ts`). `processWhatsAppQueue` la captura **específicamente** → mensaje guiado + `completed` (sin retry). Cualquier otro error de resolución se re-lanza al catch externo (retry normal). No volver a un `throw new Error` genérico ahí.
- **Consultas vs gasto:** `parseQueryCommand` corre **antes** del parseo de gasto y de `isCommandMessage`. `resumen` pelado devuelve `null` a propósito (lo maneja el `resumen` histórico legacy en `handleCommand`); `resumen <periodo>` sí es consulta. Las cuentas en `mis cuentas` salen de `listCanonical` (colección canónica top-level), no de `listByUser` (modelo legacy `users/{uid}/accounts`).
- **`needsReview` de método de pago:** desviación deliberada del ROADMAP literal — solo se marca cuando hay un método explícito (texto/imagen) que no resuelve, no cuando simplemente no se menciona método (un "50 almuerzo" cae a `efectivo` sin review).

## 8. Estilo de cambios

- Cambios pequeños y enfocados. Este repo no tiene tests, así que diff grandes son riesgosos.
- No añadas comentarios que solo describan *qué* hace el código (los nombres ya lo hacen). Reserva comentarios para *por qué* — invariantes, workarounds, decisiones de prompt.
- No reformatees archivos completos por gusto. ESLint marca lo que importa.
- Documentación viva en `docs/`. Si añades una feature nueva, actualiza `docs/FEATURES.md` y, si corresponde, `docs/EXAMPLES.md` y este `CLAUDE.md`.

## 9. Roadmap próximo (contexto para "pre mejoras")

Fuente única: [`docs/ROADMAP.md`](docs/ROADMAP.md). Fase "validaciones + clasificación inteligente", decisiones cerradas al 2026-05-14.

**Ya implementado (§ D #1–#11):** schemas `accounts`/`movements`/`learning_log`; `AccountService`/`MovementService`/`LearningLogService`; `saveExpense` transaccional; backfill (`npm run backfill:accounts`); cuenta activa + moneda heredada + comandos de cuenta; flujo `classify()` nuevo; validación de monto/método; parser de fecha; `finalizeAndRegisterExpense` unificado en los 3 canales; comandos wallet (`saldo`/`ingreso`/`transferir`/`movimientos`); `pendientes`/`clasificar`/`mi historial`/`olvidar historial`; idempotencia por `MessageSid`; auditoría denormalizada; índices en `firestore.indexes.json`; `getExpenseSummary` por mes arreglado; `isValidAudioType` centralizado; dead code de `InferenceService` eliminado.

Además ya hecho: § G.1 (fallback LLM de fecha, monto atípico, método ambiguo), § A.3 parcial (Functions v2 + `defineSecret`), tests `node:test`.

**Pendiente:**
- § A.3 resto: absorber webhook de Twilio en este repo (`twilioWebhook` HTTPS) + validación de firma `X-Twilio-Signature`. Hoy el webhook vive en el Phase 1 externo.
- § A.4 resto: dashboard web, export CSV, más cobertura de tests (Firestore/integración con `firebase-functions-test`).
- Validación en emulador / runtime (nada se ejecutó aún; v2 + transacciones validadas solo por tipos+lint+tests de lógica pura).

**Reglas críticas (siguen vigentes):**
- `accounts.saldo` es caché; fuente de verdad `users/{uid}/movements`. Toda escritura que mueva saldo va dentro de `db.runTransaction()`.
- Match por palabra completa (`phraseMatches`) sobre texto normalizado; nunca `includes` substring.
- Cada decisión importante escribe en `learning_log`; las correcciones del usuario lo retroalimentan.

## 10. Comandos útiles

```bash
npm run build              # tsc → lib/
npm run lint               # eslint
npm test                   # build + node:test (lib/__tests__)
npm run serve              # build + emuladores
npm run deploy             # firebase deploy --only functions
npm run backfill:accounts  # migración accountId (idempotente; requiere ADC)
npm run logs               # tail logs producción
firebase functions:secrets:set <NAME>      # setear un secret v2
```

> Firestore rules/indexes **NO** se deployan desde este repo (ver §7). Dueño: `D:\PROYECTOS\gepres\gastos` → `cd` allí y `firebase deploy --only firestore`.
