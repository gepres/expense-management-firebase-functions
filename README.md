# Gastos Firebase Functions

Asistente de gastos por WhatsApp construido sobre **Firebase Functions + Firestore**. Recibe mensajes de texto, imágenes (comprobantes, Yape, Plin) y notas de voz, los interpreta con **Anthropic Claude** (texto + Vision) y **OpenAI** (transcripción de audio), y registra los gastos en Firestore.

Cada gasto se vincula a una **cuenta canónica** (el saldo y el ledger los gestiona el web app — el bot solo registra el gasto y lee el saldo) y cada decisión de clasificación se registra en un **historial de aprendizaje** por usuario que personaliza futuras inferencias.

> Versión: 2.7.0 · Node 22 · TypeScript 5.3 · Firebase Functions v2 (`firebase-functions@^6.6.0`) · CI en GitHub Actions

---

## Tabla de Contenidos

- [Arquitectura](#arquitectura)
- [Stack](#stack)
- [Estructura del Proyecto](#estructura-del-proyecto)
- [Configuración Rápida](#configuración-rápida)
- [Cloud Functions Expuestas](#cloud-functions-expuestas)
- [Modelo de Datos (Firestore)](#modelo-de-datos-firestore)
- [Uso desde WhatsApp](#uso-desde-whatsapp)
- [Comandos NPM](#comandos-npm)
- [Documentación Extendida](#documentación-extendida)
- [Estado y Próximas Mejoras](#estado-y-próximas-mejoras)

---

## Arquitectura

```
Usuario (WhatsApp)
      │
      ▼
   Twilio ──webhook──► twilioWebhook (HTTPS, valida firma) ──insert──► whatsapp_queue (Firestore)
                                                              │ onCreate
                                                              ▼
                                                  processWhatsAppQueue (Cloud Function)
                                                              │
        ┌─────────────────────────────────────────────────────┼─────────────────────────────────┐
        │                                                     │                                 │
        ▼                                                     ▼                                 ▼
  Texto: regex + Anthropic                       Imagen: Anthropic Vision           Audio: OpenAI STT → Anthropic
        │                                                     │                                 │
        └───────────────► Inference (categoría / subcategoría / método pago / moneda / voucher) ◄┘
                                                              │
                                                              ▼
                                                  expenses (Firestore)  +  Twilio reply
```

Tres canales de entrada (texto / imagen / audio), un único pipeline de inferencia y persistencia.

---

## Stack

| Capa            | Tecnología                                     |
|-----------------|------------------------------------------------|
| Runtime         | Node.js 22, Firebase Functions v2 (v6)         |
| Lenguaje        | TypeScript 5.3 (strict)                        |
| Persistencia    | Firestore                                      |
| Mensajería      | Twilio WhatsApp Business API                   |
| NLU (texto/img) | Anthropic Claude — Sonnet 4.6 (vision/parse) + Haiku 4.5 (helpers), por env |
| Transcripción   | OpenAI (`gpt-4o-mini-transcribe`, por env)     |
| IA compartida   | `@gastos/expense-ai` (vendoreada) — prompts, modelos, parsers, ranking de clasificación y schema `learning_log`; single source of truth con el web app. Editar SOLO el paquete → `npm run sync` → `npm i` |
| Lint            | ESLint + Google config                         |

---

## Estructura del Proyecto

```
gastos-firebase-functions/
├── src/
│   ├── index.ts                          # Entrypoint y trigger principal
│   ├── types/index.ts                    # Interfaces compartidas
│   ├── config/
│   │   ├── models.ts                     # Modelos por env (tier Anthropic + OpenAI STT)
│   │   └── help.ts                       # Fuente única de ayuda/onboarding (menú + temas)
│   ├── services/
│   │   ├── anthropic.service.ts          # Parseo texto + Vision (imagen)
│   │   ├── transcription.service.ts      # OpenAI STT (audio → texto)
│   │   ├── inference.service.ts          # Categoría/subcat/método/moneda/voucher
│   │   ├── expense.service.ts            # CRUD + summary/consultas por rango
│   │   ├── account.service.ts            # Cuenta activa + cuentas canónicas
│   │   ├── onboarding.service.ts         # Primer contacto (idempotente)
│   │   ├── pending-action.service.ts     # Estado de conversación (confirmar sí/no, TTL)
│   │   ├── user.service.ts               # Validación por whatsappPhone
│   │   └── twilio.service.ts             # Envío de mensajes WhatsApp
│   └── utils/
│       ├── message-parser.ts             # Normalización, regex, comandos, consultas
│       └── media-downloader.ts           # Descarga autenticada de Twilio media
├── .github/workflows/ci.yml              # CI: test (lint+build+test) + smoke (emulador)
├── docs/                                 # Documentación extendida (ver más abajo)
├── firebase.json                         # solo functions + emuladores (sin firestore)
├── .firebaserc
├── package.json
└── tsconfig.json
```

---

## Configuración Rápida

> Versión completa paso a paso: [`docs/SETUP.md`](docs/SETUP.md). Para el camino corto: [`docs/QUICKSTART.md`](docs/QUICKSTART.md).

1. **Instalar dependencias**
   ```bash
   npm install
   ```
2. **Variables de entorno** — copiar y rellenar `.env`:
   ```bash
   cp .env.example .env
   ```
   Variables requeridas:
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`
   - `ANTHROPIC_API_KEY`
   - `OPENAI_API_KEY` (necesaria para procesar audios)

   Variables opcionales (modelos por env, no-secretas — resueltas en `src/config/models.ts`; si se omiten se usan los defaults):
   - `ANTHROPIC_MODEL_PRIMARY` (vision + parse principal, default `claude-sonnet-4-6`)
   - `ANTHROPIC_MODEL_HELPER` (fallbacks acotados, default `claude-haiku-4-5`)
   - `OPENAI_MODEL_TRANSCRIBE` (audio, default `gpt-4o-mini-transcribe`)

   > Cambiar un modelo no requiere tocar código pero **sí redeploy** (el `.env` se bundlea en Functions v2). `output_config.effort` se manda solo si el modelo Anthropic lo soporta (Sonnet 4.6+/Opus 4.5+; Haiku da 400) — esa regla la resuelve `models.ts`, no el call-site.
3. **Configurar Secrets v2 (producción)**
   ```bash
   firebase functions:secrets:set TWILIO_ACCOUNT_SID
   firebase functions:secrets:set TWILIO_AUTH_TOKEN
   firebase functions:secrets:set TWILIO_WHATSAPP_NUMBER
   firebase functions:secrets:set ANTHROPIC_API_KEY
   firebase functions:secrets:set OPENAI_API_KEY
   ```
4. **Compilar y desplegar**
   ```bash
   npm run build
   npm run deploy
   ```

---

## Cloud Functions Expuestas

### `processWhatsAppQueue`
- **Tipo:** Background trigger
- **Trigger:** `firestore.document("whatsapp_queue/{queueId}").onCreate`
- **Flujo:**
  1. Marca el documento como `processing`.
  2. Normaliza el teléfono y valida al usuario (`users.whatsappPhone`). Si no existe, responde y termina.
  2b. **Onboarding automático:** en el primer contacto tras vincular WhatsApp envía la bienvenida (idempotente vía `OnboardingService`; no se repite en reintentos ni a usuarios con historial previo).
  2c. **Sin cuenta canónica:** si el usuario no tiene cuenta, responde con un mensaje guiado (crear cuenta en la app) y termina `completed` — no reintenta.
  2d. **Cuota de IA:** antes de cualquier camino con IA (imagen/audio/fallback LLM) valida la cuota mensual del usuario (`QuotaService.checkQuota`, mismo doc que el backend). Si excede, responde con la fecha de reinicio y termina `completed` — sin reintento. Comandos/regex no se bloquean. Ver `docs/FEATURES.md` § Consumo y cuota de IA.
  3. Detecta el tipo de contenido:
     - **Audio** (`audio/ogg`, `mpeg`, `mp4`, `amr`, `wav`) → `TranscriptionService` (OpenAI STT) → `AnthropicService.parseExpenseMessage`.
     - **Imagen** (`image/jpeg`, `png`, `gif`, `webp`) → `AnthropicService.extractReceiptData` (Vision).
     - **Texto** → regex (`MessageParser.parseExpenseFromText`), fallback a Anthropic si falla.
  4. `InferenceService` resuelve `categoría`, `subcategoría`, `metodoPago`, `moneda`, `voucherType` usando las subcolecciones del usuario.
  5. `ExpenseService.saveExpense` persiste el gasto en `expenses`.
  6. `TwilioService.sendMessage` envía confirmación.
  7. En error: reintenta hasta 3 veces (estado vuelve a `pending`, incrementa `retryCount`). Tras 3 fallos pasa a `failed` y notifica al usuario.

### `twilioWebhook`
- **Tipo:** HTTPS (v2 `onRequest`)
- **Flujo:** valida `X-Twilio-Signature` (403 si inválida), mapea el POST de Twilio y encola en `whatsapp_queue` (`status: "pending"`). Responde TwiML vacío `200`. Reemplaza la Phase 1 externa.

### `exportExpenses`
- **Tipo:** HTTPS (v2 `onRequest`)
- **Auth:** `Authorization: Bearer <Firebase ID token>` — exporta solo los gastos del `uid` del token.
- **Query:** `?month=YYYY-MM` opcional.
- **Respuesta:** `text/csv` (adjunto). Habilita un dashboard/export sin abrir `firestore.rules` a lectura directa.

### `healthCheck`
- **Tipo:** HTTPS (v2 `onRequest`)
- **Respuesta:** JSON con `status`, `timestamp`, `service` y flags de features activas.

### `onWhatsAppQueueFailed`
- **Tipo:** Background trigger (`onDocumentUpdated` sobre `whatsapp_queue/{queueId}`)
- **Flujo:** única superficie de observabilidad. Cuando un doc transiciona a `status: "failed"` emite un log estructurado estable `jsonPayload.event="whatsapp_queue_failed"` para una alert policy de Cloud Logging:
  ```
  resource.type="cloud_run_revision"
  jsonPayload.event="whatsapp_queue_failed"
  severity=ERROR
  ```
  Guard con early-return → costo ~nulo en los updates normales (pending/processing/completed).

---

## Modelo de Datos (Firestore)

> **Importante:** los gastos se vinculan al usuario por `userId`, **no por `phoneNumber`**. El teléfono solo se usa para resolver al usuario en `whatsapp_queue` y para enviar respuestas.

### `users/{userId}`
```ts
{
  name?: string;
  email?: string;
  whatsappPhone?: string;     // ej. "+51999999999"
  whatsappLinkedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}
```

### `users/{userId}/categories/{categoryId}`
```ts
{
  nombre: string;
  subcategorias?: Array<{
    id: string;
    nombre: string;
    suggestions_ideas?: string[];  // palabras clave para matching
  }>;
}
```

### `users/{userId}/payment_methods/{methodId}`
```ts
{ nombre: string }
```

### `users/{userId}/accounts/{accountId}`
```ts
{
  nombre: string;
  isPrimary: boolean;          // exactamente una true por usuario
  moneda: string;              // PEN | USD | ...
  tipo?: "personal" | "negocio" | "compartida";
  saldo: number;               // caché; fuente de verdad: movements
  saldoInicial: number;
  saldoMinimoAlerta?: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

### `users/{userId}/movements/{movementId}` (ledger append-only)
```ts
{
  accountId: string;
  tipo: "gasto" | "ingreso" | "transferencia_in" | "transferencia_out" | "ajuste" | "reversion";
  monto: number;               // siempre positivo
  signoEfectivo: -1 | 1;
  expenseId?: string;
  transferPairId?: string;
  descripcion: string;
  fecha: Timestamp;
  saldoAnterior: number;
  saldoNuevo: number;
  createdAt: Timestamp;
}
```

### `users/{userId}/learning_log/{entryId}` (append-only)
```ts
{
  expenseId?: string;
  type: "classification" | "user_correction" | ...;
  input: { raw: string; normalized: string; channel: "text"|"image"|"audio" };
  decision: { field: string; value: string|number; source: string; matchedTerm?: string };
  userFeedback?: { correctedValue: string|number; at: Timestamp; via: string };
  tokens?: string[];           // para queryRelevant (array-contains-any)
  createdAt: Timestamp;
  deletedAt?: Timestamp;       // soft delete
}
```

### `users/{userId}/sessions/whatsapp`
```ts
{ activeAccountId: string; setAt: Timestamp; expiresAt: Timestamp }
```

### `whatsapp_queue/{queueId}`
```ts
{
  phoneNumber: string;
  message: string;
  webhookBody: TwilioWebhookBody;   // incluye MediaUrl0, MediaContentType0, NumMedia
  status: "pending" | "processing" | "completed" | "failed";
  createdAt: Timestamp;
  processedAt?: Timestamp;
  error?: string;
  retryCount: number;
}
```

### `expenses/{expenseId}`
```ts
{
  userId: string;
  accountId: string;                 // cuenta a la que pertenece el gasto
  monto: number;
  categoria: string;                 // id de Category | "sin_clasificar"
  subcategoria: string | null;       // id de Subcategory
  descripcion: string;
  fecha: Timestamp;
  metodoPago: string;                // yape | plin | efectivo | tarjeta | transferencia | otro | id custom
  moneda: string;                    // PEN | USD | EUR | ...
  recurrente: boolean;
  reimbursementStatus: "pending" | "approved" | "rejected";
  voucherType: string;               // boleta | factura | recibo | nota_venta
  // Auditoría de inferencia (best-effort)
  matchedTerm?: string | null;
  matchedLevel?: "suggestion"|"subcategory"|"category"|"history"|"user_correction"|"default";
  currencySource?: "text"|"account"|"default";
  dateSource?: "regex"|"llm"|"message"|"default";
  paymentMethodSource?: "text"|"inferred"|"fallback";
  needsClassification?: boolean;     // true si quedó "sin_clasificar"
  needsReview?: boolean;             // true si el método de pago no se reconoció
  messageSid?: string;               // idempotencia anti-duplicado
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

---

## Uso desde WhatsApp

### Registrar gastos por texto
```
50 almuerzo
25.50 taxi con yape
Gasté 100 en supermercado
```

### Registrar gastos por imagen
- Comprobantes (boleta, factura)
- Capturas de Yape / Plin
- Recibos físicos fotografiados

### Registrar gastos por audio
- Nota de voz en español: *"Gasté veinticinco soles en almuerzo"*

### Onboarding
La primera vez que escribes tras vincular WhatsApp, el bot envía solo una **bienvenida** con lo que puede hacer. `inicio` / `hola` la repiten cuando quieras.

### Ayuda (menú + temas)
| Forma | Acción |
|-------|--------|
| `ayuda` | Menú compacto con todas las áreas (alias `comandos`, `menu`) |
| `ayuda <tema>` | Detalle con ejemplos: `gastos`, `consultas`, `cuentas`, `saldo`, `pendientes`, `historial` (con aliases, p. ej. `ayuda foto`, `ayuda dinero`) |

Fuente única en `src/config/help.ts`: agregar un flujo nuevo = editar `HELP_TOPICS` y aparece solo en el menú.

### Consultas (el bot responde, no solo registra)
| Frase | Acción |
|-------|--------|
| `cuánto gasté hoy` / `cuánto llevo este mes` | Total + top categorías del periodo |
| `cuánto gasté en comida [periodo]` | Total de esa categoría en el periodo |
| `resumen mayo` / `resumen mes pasado` | Resumen con periodo explícito |
| `gastos de hoy` / `qué gasté esta semana` | Lista de gastos del periodo |
| `mis categorías` / `mis cuentas` / `mis métodos de pago` | Qué tienes configurado |

Periodos: `hoy`, `ayer`, `esta semana`, `este mes`, `mes pasado`, nombre de mes.

### Comandos
| Comando | Alias / forma                               | Acción                         |
|---------|---------------------------------------------|--------------------------------|
| `inicio`| `hola`, `hi`, `start`                       | Bienvenida / onboarding        |
| `resumen`| `summary`, `total`, `ver gastos`           | Total histórico por categoría  |
| `saldo` | `mi saldo`                                  | Saldo de la cuenta activa (canónica) |
| `saldos`| `saldo de cuentas`                          | Saldo de todas las cuentas (canónicas) |
| `movimientos` | —                                     | Deriva a la app (el bot no lleva ledger) |
| `ingreso` / `transferir` | —                          | Deriva a la app (saldo/ledger = web app) |
| `usar cuenta <nombre>` | `cuenta actual`, `cuenta principal` | Cambia/consulta la cuenta activa |
| `pendientes` | `clasificar`                          | Gastos sin clasificar / a revisar |
| `clasificar <id> <cat> [subcat]` | —                  | Reclasifica un gasto (alimenta el aprendizaje) |
| `mi historial` | `aprendizajes`                      | Historial de aprendizaje       |
| `olvidar historial` | + `olvidar historial confirmar` | Borra el aprendizaje (pide confirmación) |

### Editar el último gasto (sin IDs, con confirmación)
Estado de conversación corto (`users/{uid}/sessions/pending_action`, TTL 10 min). El comando deja una acción **pendiente** y el bot pide *sí/no* antes de mutar nada. Un "sí/no" suelto responde a la pendiente; un mensaje no relacionado la abandona (no atrapa al usuario).

| Comando | Alias / forma | Acción |
|---------|---------------|--------|
| `borrar último` | `eliminar el último`, `deshacer` | Borra tu último gasto (confirma sí/no) |
| `corregir monto <n>` | `"no, eran <n>"`, `"el último era <n>"` | Corrige el monto del último gasto (confirma sí/no) |
| `sí` / `no` | `confirmar`, `cancelar`, … | Responde a la confirmación pendiente |

```
Tú: 50 almuerzo        → ✅ registrado
Tú: no, eran 60        → ✏️ ¿Corrijo «almuerzo» 50 → 60? sí/no
Tú: sí                 → ✅ Listo: ahora PEN 60.00
```

Ejemplos detallados de I/O en [`docs/EXAMPLES.md`](docs/EXAMPLES.md).

---

## Comandos NPM

| Comando             | Descripción                                          |
|---------------------|------------------------------------------------------|
| `npm run build`     | Compila TypeScript a `lib/`                          |
| `npm run build:watch` | Compilación incremental                            |
| `npm run lint`      | Ejecuta ESLint                                       |
| `npm test`          | Build + `node:test` (lib/__tests__)                  |
| `npm run smoke`     | Build + `emulators:exec` → smoke end-to-end          |
| `npm run serve`     | Build + emuladores Firebase (solo functions)         |
| `npm run shell`     | Functions shell interactivo                          |
| `npm run deploy`    | `firebase deploy --only functions`                   |
| `npm run backfill:accounts` | Migración idempotente de `accountId` (requiere ADC) |
| `npm run logs`      | Tail de logs de Cloud Functions                      |

---

## Documentación Extendida

| Documento | Cuándo leerlo |
|-----------|---------------|
| [`docs/QUICKSTART.md`](docs/QUICKSTART.md) | Levantar el proyecto en ~10 minutos |
| [`docs/SETUP.md`](docs/SETUP.md) | Configuración detallada Firebase / Twilio / Anthropic / OpenAI |
| [`docs/FEATURES.md`](docs/FEATURES.md) | Catálogo completo de features (texto, imagen, audio, inferencia) |
| [`docs/EXAMPLES.md`](docs/EXAMPLES.md) | Mensajes soportados, respuestas, snippets de código |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Diagrama detallado, data flow, costos, scaling |
| [`CLAUDE.md`](CLAUDE.md) | Guía operativa para sesiones de Claude Code |

---

## Estado y Próximas Mejoras

Registro de decisiones e historia: [`docs/ROADMAP.md`](docs/ROADMAP.md) (ver el bloque **"Estado al 2026-05-16"** al inicio).

**Ya hecho (en `main`):**
- Cuenta **canónica** (top-level `accounts`, dueño: web app). El bot **NO** gestiona saldo/ledger (decisión "Opción A"): `saveExpense` solo escribe el expense; `saldo`/`saldos` son lectura canónica; `ingreso`/`transferir`/`movimientos` derivan al web app.
- Moneda heredada de la cuenta; validación dura de monto/método/fecha (regex + LLM); flujo de clasificación `suggestions_ideas` → subcategoría → categoría → historial → LLM acotado → `sin_clasificar`; `learning_log` que retroalimenta.
- Ayuda menú + temas, onboarding automático, consultas (`cuánto gasté hoy`, `gastos de hoy`, `mis categorías/cuentas/métodos`), corregir/borrar último gasto con confirmación (estado de conversación).
- Functions v2 + `defineSecret`, webhook Twilio absorbido + validación de firma, `getExpenseSummary` por mes arreglado, Node 22 + `firebase-functions@^6.6.0`, CI (GitHub Actions: test + smoke), alerta `onWhatsAppQueueFailed` (policy versionada en [`ops/`](ops/)).

**Pendiente (backlog priorizado):**
- Aplicar la alert policy (`ops/README.md`, 1 paso `gcloud`).
- Tests de integración del pipeline (`firebase-functions-test`) + cache por invocación de categorías/payment_methods.
- Rate-limit / tope de costo por usuario (Anthropic/OpenAI).
- UX: multi-gasto en un mensaje, ingreso en lenguaje natural, presupuestos/alertas (leer `presupuestos` del web app), botones nativos WhatsApp, nudges proactivos (ventana 24 h / plantillas Meta).
- Mantenimiento diferido: `firebase-functions` v7 (major), `firebase-admin` v13, JDK ≥ 21.

**Producto (largo plazo, fuera de este repo):** Dashboard web, export Excel.

---

## Licencia

MIT
