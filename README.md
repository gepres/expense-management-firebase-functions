# Gastos Firebase Functions

Asistente de gastos por WhatsApp construido sobre **Firebase Functions + Firestore**. Recibe mensajes de texto, imágenes (comprobantes, Yape, Plin) y notas de voz, los interpreta con **Anthropic Claude** (texto + Vision) y **OpenAI** (transcripción de audio), y registra los gastos en Firestore.

Cada gasto se vincula a una **cuenta** (wallet con saldo sincronizado vía ledger de movimientos) y cada decisión de clasificación se registra en un **historial de aprendizaje** por usuario que personaliza futuras inferencias.

> Versión: 2.3.0 · Node 20 · TypeScript 5.3 · Firebase Functions v2

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
- [Próximas Mejoras](#próximas-mejoras)

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
| Runtime         | Node.js 20, Firebase Functions v2              |
| Lenguaje        | TypeScript 5.3 (strict)                        |
| Persistencia    | Firestore                                      |
| Mensajería      | Twilio WhatsApp Business API                   |
| NLU (texto/img) | Anthropic Claude — Sonnet 4.6 (vision/parse) + Haiku 4.5 (helpers), por env |
| Transcripción   | OpenAI (`gpt-4o-mini-transcribe`, por env)     |
| Lint            | ESLint + Google config                         |

---

## Estructura del Proyecto

```
gastos-firebase-functions/
├── src/
│   ├── index.ts                          # Entrypoint y trigger principal
│   ├── types/index.ts                    # Interfaces compartidas
│   ├── config/models.ts                  # Modelos por env (tier Anthropic + OpenAI STT)
│   ├── services/
│   │   ├── anthropic.service.ts          # Parseo texto + Vision (imagen)
│   │   ├── transcription.service.ts      # OpenAI STT (audio → texto)
│   │   ├── inference.service.ts          # Categoría/subcat/método/moneda/voucher
│   │   ├── expense.service.ts            # CRUD + summary en Firestore
│   │   ├── user.service.ts               # Validación por whatsappPhone
│   │   └── twilio.service.ts             # Envío de mensajes WhatsApp
│   └── utils/
│       ├── message-parser.ts             # Normalización, regex, comandos
│       └── media-downloader.ts           # Descarga autenticada de Twilio media
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

### Comandos
| Comando | Alias / forma                               | Acción                         |
|---------|---------------------------------------------|--------------------------------|
| `inicio`| `hola`, `hi`, `start`                       | Mensaje de bienvenida          |
| `resumen`| `summary`, `total`, `ver gastos`           | Total + breakdown por categoría|
| `ayuda` | `help`, `comandos`, `commands`              | Lista de comandos              |
| `saldo` | `mi saldo`                                  | Saldo de la cuenta activa      |
| `saldos`| `saldo de cuentas`                          | Saldo de todas las cuentas     |
| `movimientos` | —                                     | Últimos movimientos            |
| `ingreso <monto> <desc>` | —                          | Registra un ingreso            |
| `transferir <monto> a <cuenta>` | —                   | Transferencia entre cuentas    |
| `usar cuenta <nombre>` | `cuenta actual`, `cuenta principal` | Cambia/consulta la cuenta activa |
| `pendientes` | `clasificar`                          | Gastos sin clasificar / a revisar |
| `clasificar <id> <cat> [subcat]` | —                  | Reclasifica un gasto (alimenta el aprendizaje) |
| `mi historial` | `aprendizajes`, `olvidar historial` | Historial de aprendizaje       |

Ejemplos detallados de I/O en [`docs/EXAMPLES.md`](docs/EXAMPLES.md).

---

## Comandos NPM

| Comando             | Descripción                                          |
|---------------------|------------------------------------------------------|
| `npm run build`     | Compila TypeScript a `lib/`                          |
| `npm run build:watch` | Compilación incremental                            |
| `npm run lint`      | Ejecuta ESLint                                       |
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

## Próximas Mejoras

Roadmap completo y fuente única: [`docs/ROADMAP.md`](docs/ROADMAP.md). Todas las decisiones de alcance cerradas al 2026-05-14.

**Fase actual — Validaciones + clasificación inteligente:**
- Concepto de `accounts` con **saldo sincronizado** (wallet + ledger en `movements`, transacciones Firestore atómicas).
- Cambio de cuenta por comando WhatsApp o desde configuración del usuario.
- Moneda heredada de la cuenta; validación dura de monto, método de pago y fecha (regex + LLM).
- Nuevo flujo de clasificación: `suggestions_ideas` → subcategoría → categoría → historial → `sin_clasificar`.
- **Historial de aprendizaje** por usuario (`learning_log`) que retroalimenta futuras decisiones.
- Comandos nuevos: `saldo`, `ingreso`, `transferir`, `usar cuenta <nombre>`, `pendientes`, `mi historial`.

**Mantenimiento e infraestructura:** Migración a Functions v2 + `defineSecret`, fix `getExpenseSummary` por mes, cache por invocación de categorías/payment methods, tests con `firebase-functions-test`, absorber webhook de Twilio + validación de firma.

**Producto (largo plazo):** Dashboard web con saldo y movimientos, export CSV/Excel, alertas de saldo bajo y presupuestos.

---

## Licencia

MIT
