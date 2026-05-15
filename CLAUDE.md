# CLAUDE.md — Guía operativa para Claude Code

Este archivo orienta a futuras sesiones de Claude Code dentro de **gastos-firebase-functions**. Leerlo antes de tocar código o documentación.

## 1. ¿Qué es este proyecto?

Asistente de gastos por WhatsApp. Cloud Function que se dispara `onCreate` sobre `whatsapp_queue` en Firestore, procesa el mensaje (texto, imagen o audio), infiere categoría/método de pago/moneda y guarda el gasto en `expenses`. Responde por WhatsApp vía Twilio.

- Runtime: **Node 20**, **Firebase Functions v2** (`onDocumentCreated`/`onRequest`), **TypeScript 5.3** (strict).
- NLU: **Anthropic Claude `claude-sonnet-4-20250514`** (texto + Vision).
- Audio: **OpenAI Whisper (`whisper-1`)**, idioma `es`.
- Mensajería: **Twilio WhatsApp**.

## 2. Mapa del código

```
src/index.ts                          ← trigger + orquestación + finalizeAndRegisterExpense + comandos
src/types/index.ts                    ← interfaces compartidas (incl. Account, Movement, LearningLog, BotCommand)
src/services/
  anthropic.service.ts                ← parseExpenseMessage + extractReceiptData (Vision)
  transcription.service.ts            ← Whisper, escribe a tmpfile y limpia
  inference.service.ts                ← classify() + resolvePaymentMethod + resolveCurrency + inferVoucherType
  expense.service.ts                  ← saveExpense (transaccional) + getPending/getById/findByMessageSid/summary
  account.service.ts                  ← cuentas + resolución de cuenta activa + sesión wsp
  movement.service.ts                 ← ledger append-only (writeMovement/transfer), fuente de verdad del saldo
  learning-log.service.ts             ← bitácora de decisiones por usuario (queryRelevant/append/feedback)
  user.service.ts                     ← lookup por whatsappPhone
  twilio.service.ts                   ← sendMessage
src/utils/
  message-parser.ts                   ← normalizeForMatching, validateAmount, parseDateFromText, parsers de comandos
  media-downloader.ts                 ← descarga media de Twilio con basic auth
  media-types.ts                      ← fuente única de tipos de media (audio/imagen)
src/scripts/
  backfill-accounts.ts                ← migración idempotente: accountId en expenses históricos
```

Punto de entrada lógico: `processWhatsAppQueue` en `src/index.ts`. Toda registración de gasto (texto/imagen/audio) converge en `finalizeAndRegisterExpense`.

## 3. Convenciones del repo

- **Idioma de los mensajes/UX:** español (Perú). Soles, Yape, Plin, "bodega", etc.
- **Identidad del gasto:** vinculado por `userId` + `accountId`, **no** por `phoneNumber`. El teléfono solo resuelve al usuario.
- **Cuenta activa:** todo gasto va a una cuenta (`AccountService.resolveActiveAccount`: sesión wsp → primary → primera → crea "Principal" lazy). Sin `accountId`, `saveExpense` rechaza.
- **Saldo:** `accounts.saldo` es **caché denormalizado**. La fuente de verdad es `users/{uid}/movements` (ledger append-only). `saveExpense` escribe expense + movement + saldo en **una sola `db.runTransaction()`**. Nunca romper esa atomicidad.
- **Nombres de campos en Firestore:** español (`monto`, `categoria`, `descripcion`, `fecha`, `metodoPago`, `moneda`, `voucherType`, `accountId`). Mantener consistencia.
- **Fechas:** `expense.fecha` se guarda como `Timestamp`. Prioridad de resolución: fecha en el texto (`MessageParser.parseDateFromText`) → fecha del mensaje (`whatsapp_queue.createdAt`) → ya **no** hay default `new Date()` del processing. `dateSource` queda persistido.
- **Clasificación (`InferenceService.classify`):** orden estricto `suggestions_ideas` → nombre subcategoría → nombre categoría → historial (`learning_log`) → `sin_clasificar` (`needsClassification: true`). Match por **palabra/frase completa** sobre texto normalizado (`phraseMatches`), nunca `includes` substring. Devuelve `matchedTerm`/`matchedLevel` que se persisten para auditoría.
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

Resolución: `defineSecret` en `index.ts` → bindeado a la función → `process.env.<NAME>` en runtime → leído por cada service. Configurar con `firebase functions:secrets:set <NAME>` (NO `functions:config:set`, que era v1). Localmente, `.env` con esas mismas variables. No hardcodear nunca.

## 7. Trampas conocidas

- **Índices Firestore obligatorios:** las queries de `movements` (`accountId`+`fecha`), `learning_log` (`type`+`tokens` array-contains), `expenses` (`userId`+`createdAt`, `userId`+`fecha`, `userId`+`needsClassification`, `userId`+`needsReview`) requieren los índices de `firestore.indexes.json`. Desplegarlos con `firebase deploy --only firestore:indexes` **antes** de usar `pendientes`/`movimientos`/resumen por mes.
- **Migración previa al deploy:** correr `npm run backfill:accounts` una vez (idempotente). Sin `accountId` los expenses históricos no aparecen en queries por cuenta. El ledger arranca en cero (no se reproducen movements históricos) — el saldo real lo fija el usuario con `ingreso`/`ajustar`.
- **Idempotencia depende de `MessageSid`:** `finalize` salta duplicados solo si `webhookBody.MessageSid` está presente en el doc de `whatsapp_queue`. Si el Phase 1 externo no lo guarda, no hay protección anti-duplicado.
- **`extractReceiptData`** confía en que Anthropic devuelva JSON. Hay parseo defensivo de ```` ```json ```` pero un JSON malformado tira el flujo al `catch`. El retry lo cubre — ojo si cambias el prompt.
- **`AnthropicService.parseExpenseMessage`** aún retorna `voucherType: "boleta"` por defecto; `finalize` lo ignora y reinfiere con `inferVoucherType`. Ruido residual, no bug.
- **`getExpenseSummary` por mes:** ya arreglado (usa `Timestamp.fromDate` con cotas `[mes, mes+1)`).
- **`isValidAudioType` centralizado** en `src/utils/media-types.ts`. Añadir formatos en **un solo** lugar.
- **Mensaje sin texto y sin media:** se marca `completed` con `error: "No content to process"`. No responde al usuario; decisión consciente para no spamear.
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
firebase deploy --only firestore:indexes   # publicar índices
firebase deploy --only firestore:rules     # publicar reglas
firebase functions:secrets:set <NAME>      # setear un secret v2
```
