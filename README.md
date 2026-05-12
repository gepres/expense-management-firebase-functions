# Gastos Firebase Functions

Asistente de gastos por WhatsApp construido sobre **Firebase Functions + Firestore**. Recibe mensajes de texto, imágenes (comprobantes, Yape, Plin) y notas de voz, los interpreta con **Anthropic Claude** (texto + Vision) y **OpenAI Whisper** (audio), y registra los gastos en Firestore.

> Versión: 2.1.0 · Node 20 · TypeScript 5.3 · Firebase Functions v1

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
   Twilio  ──webhook──►  Backend Phase 1  ──insert──►  whatsapp_queue (Firestore)
                                                              │ onCreate
                                                              ▼
                                                  processWhatsAppQueue (Cloud Function)
                                                              │
        ┌─────────────────────────────────────────────────────┼─────────────────────────────────┐
        │                                                     │                                 │
        ▼                                                     ▼                                 ▼
  Texto: regex + Anthropic                       Imagen: Anthropic Vision           Audio: Whisper → Anthropic
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
| Runtime         | Node.js 20, Firebase Functions v1              |
| Lenguaje        | TypeScript 5.3 (strict)                        |
| Persistencia    | Firestore                                      |
| Mensajería      | Twilio WhatsApp Business API                   |
| NLU (texto/img) | Anthropic Claude (`claude-sonnet-4-20250514`)  |
| Transcripción   | OpenAI Whisper (`whisper-1`)                   |
| Lint            | ESLint + Google config                         |

---

## Estructura del Proyecto

```
gastos-firebase-functions/
├── src/
│   ├── index.ts                          # Entrypoint y trigger principal
│   ├── types/index.ts                    # Interfaces compartidas
│   ├── services/
│   │   ├── anthropic.service.ts          # Parseo texto + Vision (imagen)
│   │   ├── transcription.service.ts      # Whisper (audio → texto)
│   │   ├── inference.service.ts          # Categoría/subcat/método/moneda/voucher
│   │   ├── expense.service.ts            # CRUD + summary en Firestore
│   │   ├── user.service.ts               # Validación por whatsappPhone
│   │   └── twilio.service.ts             # Envío de mensajes WhatsApp
│   └── utils/
│       ├── message-parser.ts             # Normalización, regex, comandos
│       └── media-downloader.ts           # Descarga autenticada de Twilio media
├── docs/                                 # Documentación extendida (ver más abajo)
├── firebase.json
├── firestore.rules
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
3. **Configurar Firebase Functions Config (producción)**
   ```bash
   firebase functions:config:set \
     twilio.account_sid="ACxxxxx" \
     twilio.auth_token="xxxxx" \
     twilio.whatsapp_number="whatsapp:+14155238886" \
     anthropic.api_key="sk-ant-xxxxx" \
     openai.api_key="sk-xxxxx"
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
     - **Audio** (`audio/ogg`, `mpeg`, `mp4`, `amr`, `wav`) → `TranscriptionService` (Whisper) → `AnthropicService.parseExpenseMessage`.
     - **Imagen** (`image/jpeg`, `png`, `gif`, `webp`) → `AnthropicService.extractReceiptData` (Vision).
     - **Texto** → regex (`MessageParser.parseExpenseFromText`), fallback a Anthropic si falla.
  4. `InferenceService` resuelve `categoría`, `subcategoría`, `metodoPago`, `moneda`, `voucherType` usando las subcolecciones del usuario.
  5. `ExpenseService.saveExpense` persiste el gasto en `expenses`.
  6. `TwilioService.sendMessage` envía confirmación.
  7. En error: reintenta hasta 3 veces (estado vuelve a `pending`, incrementa `retryCount`). Tras 3 fallos pasa a `failed` y notifica al usuario.

### `healthCheck`
- **Tipo:** HTTPS
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
  monto: number;
  categoria: string;                 // id de Category
  subcategoria: string | null;       // id de Subcategory
  descripcion: string;
  fecha: Timestamp;
  metodoPago: string;                // yape | plin | efectivo | tarjeta | transferencia | id custom
  moneda: string;                    // PEN | USD | EUR | ...
  recurrente: boolean;
  reimbursementStatus: "pending" | "approved" | "rejected";
  voucherType: string;               // boleta | factura | recibo | nota_venta
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
| Comando | Alias                                       | Acción                         |
|---------|---------------------------------------------|--------------------------------|
| `inicio`| `hola`, `hi`, `start`                       | Mensaje de bienvenida          |
| `resumen`| `summary`, `total`, `ver gastos`           | Total + breakdown por categoría|
| `ayuda` | `help`, `comandos`, `commands`              | Lista de comandos              |

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

Roadmap candidato para la siguiente iteración (ver detalles en `docs/ARCHITECTURE.md`):

- [ ] Migrar `firebase-functions/v1` → `v2` (mejor cold start y manejo de secrets).
- [ ] Reemplazar `functions.config()` (deprecado) por `defineSecret` / variables de entorno v2.
- [ ] Filtro de fecha en `getExpenseSummary` (hoy ignora `month` por usar comparación de string sobre Timestamp).
- [ ] Cache de categorías / payment methods por usuario (evitar lecturas repetidas por mensaje).
- [ ] Tests con `firebase-functions-test` (ya instalado, sin uso).
- [ ] Webhook directo de Twilio en lugar de pipeline Phase 1 → queue.
- [ ] Dashboard web para visualizar gastos.
- [ ] Export Excel/CSV y alertas de presupuesto.

---

## Licencia

MIT
