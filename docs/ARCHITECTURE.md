# Architecture

Documento técnico de referencia: diagrama, data flow, decisiones y deuda conocida.

## Objetivo

Cloud Function event-driven que procesa mensajes de WhatsApp (texto, imagen, audio) y los convierte en gastos estructurados en Firestore, con clasificación automática contra las categorías del usuario.

## Stack

- **Runtime:** Firebase Functions v2 (Node 20) — `onDocumentCreated` / `onRequest`.
- **Lenguaje:** TypeScript 5.3 (strict).
- **Persistencia:** Firestore.
- **NLU:** Anthropic Claude `claude-sonnet-4-20250514` (texto + Vision).
- **Transcripción:** OpenAI Whisper `whisper-1`, español.
- **Mensajería:** Twilio WhatsApp.

---

## Diagrama de alto nivel

```
┌─────────────┐
│  WhatsApp   │
│   Usuario   │
└──────┬──────┘
       │ mensaje (texto | imagen | audio)
       ▼
┌─────────────┐
│   Twilio    │
└──────┬──────┘
       │ webhook (POST) → twilioWebhook (valida X-Twilio-Signature)
       ▼
┌─────────────────────┐
│     Firestore       │   onCreate
│   whatsapp_queue    │ ───────────────┐
│   status: pending   │                │
└─────────────────────┘                ▼
                                ┌─────────────────────────────┐
                                │  processWhatsAppQueue       │
                                │                             │
                                │ 1. Status → processing      │
                                │ 2. UserService.lookup       │
                                │ 3. Detectar tipo (txt/img/audio)│
                                │ 4. Pipeline específico      │
                                │ 5. InferenceService         │
                                │ 6. ExpenseService.save      │
                                │ 7. TwilioService.send       │
                                │ 8. Status → completed       │
                                └──┬──────────────────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
       ┌────────────┐       ┌─────────────┐      ┌──────────────┐
       │ Anthropic  │       │ Anthropic   │      │   Whisper    │
       │ parseText  │       │ Vision      │      │ transcribe   │
       └────────────┘       └─────────────┘      └──────┬───────┘
                                                        │
                                                        ▼
                                                  Anthropic parse
                                                        │
                                                        ▼
                                                  Firestore:
                                                  expenses
                                                        │
                                                        ▼
                                                  Twilio reply
```

---

## Estructura de archivos

```
src/
├── index.ts                          # Trigger + orquestación
├── types/index.ts                    # Interfaces
├── services/
│   ├── anthropic.service.ts          # parseExpenseMessage + extractReceiptData (Vision)
│   ├── transcription.service.ts      # Whisper
│   ├── inference.service.ts          # Categoría/subcat/método/moneda/voucher
│   ├── expense.service.ts            # Firestore CRUD + summary
│   ├── user.service.ts               # Lookup por whatsappPhone
│   └── twilio.service.ts             # Envío
└── utils/
    ├── message-parser.ts             # Normalize, regex, comandos
    └── media-downloader.ts           # Descarga autenticada Twilio
```

---

## Cloud Functions

| Función                | Tipo       | Trigger                                    | Responsabilidad             |
|------------------------|------------|--------------------------------------------|-----------------------------|
| `twilioWebhook`        | HTTPS      | `onRequest` (POST de Twilio)               | Validar firma + encolar     |
| `processWhatsAppQueue` | Background | `onDocumentCreated("whatsapp_queue/{id}")` | Procesar mensaje entrante   |
| `healthCheck`          | HTTPS      | `onRequest` (GET)                          | Status del servicio         |

---

## Data flow detallado

```
1. Usuario envía mensaje
2. Twilio recibe → POST a twilioWebhook (en este repo)
3. twilioWebhook valida X-Twilio-Signature → crea doc en whatsapp_queue (status: pending)
4. Cloud Function trigger → onDocumentCreated
5. Update status: processing
6. MessageParser.normalizePhoneNumber + sanitizeInput
7. UserService.findByWhatsAppPhone
   - Si no existe → TwilioService responde + status: completed → END
8. Detectar canal:
   - hasMedia && MediaContentType0 es audio → processAudioMessage
   - hasMedia → processImageMessage
   - texto → processTextMessage
9. Pipeline específico (parse/transcribe/Vision)
10. InferenceService (categoría, subcat, método, moneda, voucher)
11. ExpenseService.saveExpense → Firestore
12. TwilioService.sendMessage (confirmación)
13. Update status: completed
14. En error → retry (max 3) → si falla, status: failed + notify usuario
```

---

## Modelo de datos

Esquema completo en [`../README.md`](../README.md#modelo-de-datos-firestore).

### Colecciones

| Colección                              | Cardinalidad estimada              | Acceso                |
|----------------------------------------|------------------------------------|-----------------------|
| `users/{uid}`                          | 1 por persona                      | Lectura por function  |
| `users/{uid}/categories/{cid}`         | ~5-15 por usuario                  | Lectura por function  |
| `users/{uid}/payment_methods/{mid}`    | ~2-5 por usuario                   | Lectura por function  |
| `whatsapp_queue/{queueId}`             | ~100-1K/día                        | RW Cloud Function     |
| `expenses/{expenseId}`                 | ~50-500/usuario/mes                | RW Cloud Function     |

### Identidad

- `expenses.userId` es la FK al usuario (no `phoneNumber`).
- `whatsappPhone` solo se usa para resolver el usuario y para enviar respuestas.

---

## Configuración y secrets

Secrets v2 (`defineSecret` en `index.ts`) bindeados a `processWhatsAppQueue`; en runtime quedan como `process.env.<NAME>` que es lo que leen los services. Setear con `firebase functions:secrets:set <NAME>`.

| Variable                | Servicio                  |
|-------------------------|---------------------------|
| `TWILIO_ACCOUNT_SID`    | Twilio API                |
| `TWILIO_AUTH_TOKEN`     | Twilio API                |
| `TWILIO_WHATSAPP_NUMBER`| Número emisor             |
| `ANTHROPIC_API_KEY`     | Claude texto + Vision     |
| `OPENAI_API_KEY`        | Whisper (audio)           |

> Migrado a Functions v2 + `defineSecret`. `functions.config()` ya no se usa.

---

## Reglas de seguridad

`firestore.rules` bloquea acceso directo a `whatsapp_queue` y `expenses` (`allow read, write: if false`). Solo el SDK admin (las funciones) puede leer/escribir.

Para el dashboard futuro, abrir `expenses.read` con `request.auth.uid == resource.data.userId`.

---

## Escalabilidad

### Capacidad estimada

| Métrica                       | Free tier             | Carga típica          |
|-------------------------------|-----------------------|------------------------|
| Function invocations          | 2M/mes                | 3K – 30K/mes          |
| Firestore reads               | 50K/día               | 500 – 5K/día          |
| Firestore writes              | 20K/día               | 300 – 3K/día          |
| Mensajes/segundo (estimado)   | —                     | ~10-20                |
| Usuarios concurrentes         | —                     | ~100-500              |

### Performance

| Operación                  | Latencia                |
|----------------------------|-------------------------|
| Cold start                 | 3 – 5 s                 |
| Texto (regex)              | < 1 s                   |
| Texto (Anthropic fallback) | 2 – 4 s                 |
| Imagen (Vision)            | 5 – 8 s                 |
| Audio (Whisper + parse)    | 6 – 10 s                |
| Inferencia                 | 200 – 400 ms            |

### Optimizaciones futuras

- Migrar a Functions v2 (mejor cold start, secrets nativos).
- Cache por invocación de `categories` / `payment_methods`.
- Separar funciones por canal (texto / imagen / audio) para concurrency tuning independiente.
- Considerar Pub/Sub si el throughput crece.

---

## Manejo de errores

### Retry policy

```
Intento 1 (retryCount 0) → fallo → pending, retryCount = 1
Intento 2 (retryCount 1) → fallo → pending, retryCount = 2
Intento 3 (retryCount 2) → fallo → pending, retryCount = 3
Fallo definitivo         → status: failed + Twilio notifica
```

### Clasificación

| Error                       | Acción del pipeline               |
|-----------------------------|-----------------------------------|
| Anthropic API failure       | Retry hasta 3                     |
| Twilio send failure         | Log y continúa (no aborta save)   |
| Firestore write failure     | Retry hasta 3                     |
| Mensaje sin contenido       | `completed` con `error` informativo (no notifica) |
| Imagen inválida             | Mensaje al usuario + `completed`  |
| Whisper falla               | Mensaje al usuario + `completed`  |
| Usuario no registrado       | Mensaje al usuario + `completed`  |

---

## Trampas conocidas (deuda técnica)

> Estas son notas para el refactor "pre mejoras". Cada item es una tarea concreta candidata para la siguiente iteración.

### 1. `ExpenseService.getExpenseSummary` con `month` no filtra
`expense.service.ts:114-118` construye strings `${month}-01` / `${month}-31` y los compara con `fecha` que es `Timestamp`. La comparación nunca matchea. Fix: usar `Timestamp.fromDate(new Date(...))`.

### 2. Validación de audio duplicada
`MediaDownloader.isValidAudioType` y `TranscriptionService.isValidAudioType` mantienen la misma lista. Centralizar.

### 3. `voucherType` devuelto por Anthropic se ignora
`AnthropicService.parseExpenseMessage` retorna `voucherType: "boleta"` por defecto, pero `index.ts` siempre reinfiere con `InferenceService.inferVoucherType`. Limpiar el tipo de retorno o respetar el valor.

### 4. ~~`functions.config()` deprecado~~ (resuelto)
Migrado a Functions v2 + `defineSecret`. Los services leen `process.env.<NAME>`.

### 5. Tests parciales
`npm test` (runner nativo `node:test`) cubre lógica pura: `MessageParser`, `phraseMatches`, `tokenizeForLearning`. Falta cobertura del flujo principal / Firestore (`firebase-functions-test` disponible, sin uso).

### 6. ~~Phase 1 acoplada~~ (resuelto)
Webhook absorbido: `twilioWebhook` (HTTPS v2) encola en `whatsapp_queue`. Ya no hay sistema externo.

### 7. ~~Validación del webhook de Twilio~~ (resuelto)
`twilioWebhook` valida `X-Twilio-Signature` con `TWILIO_AUTH_TOKEN` (403 si falla). Gotcha: la firma depende de la URL exacta — con dominio custom/proxy, `Host`/`X-Forwarded-Host` debe coincidir con lo configurado en Twilio.

### 8. Lecturas redundantes de categorías
Cada mensaje hace una lectura completa de `users/{uid}/categories` y posiblemente otra de `payment_methods`. Cache simple por invocación (Map en memoria) reduciría costo en bursts.

---

## Monitoreo

### Dashboards
- Functions: `https://console.firebase.google.com/project/<proyecto>/functions`
- Firestore usage: `.../firestore/usage`
- Billing: `.../usage`

### Logs estructurados
Niveles usados:
- `functions.logger.info` — flujo normal
- `functions.logger.warn` — parseo fallido, usuario no encontrado
- `functions.logger.error` — fallas de API o Firestore

Emojis intencionales en logs (📨 📷 🤖 ✅ ❌). Útiles para grep visual.

---

## Costos (referencia)

### 1K mensajes/mes

| Servicio        | Uso                   | Costo            |
|-----------------|-----------------------|------------------|
| Cloud Functions | 1K invocaciones       | Free             |
| Firestore       | ~6K reads / ~3K writes| Free             |
| Anthropic       | 1K requests           | ~$0.50 – $2.00   |
| Whisper         | Audios únicamente     | $0.006/min audio |
| Twilio WhatsApp | 1K mensajes           | ~$5 – $10        |
| **Total**       |                       | **~$5.50 – $12** |

### 10K mensajes/mes

| Servicio        | Uso                     | Costo              |
|-----------------|-------------------------|--------------------|
| Cloud Functions | 10K invocaciones        | Free               |
| Firestore       | ~60K reads / ~30K writes| ~$0.50 – $1.00     |
| Anthropic       | 10K requests            | ~$5 – $20          |
| Whisper         | Audios                  | variable           |
| Twilio WhatsApp | 10K mensajes            | ~$50 – $100        |
| **Total**       |                         | **~$55 – $120**    |

---

## Roadmap

Fuente única: [`ROADMAP.md`](ROADMAP.md). Resumen de los bloques actuales:

### Fase actual — Validaciones + clasificación inteligente
- Wallet con saldo sincronizado: `users/{uid}/accounts` + ledger `users/{uid}/movements`.
- Cambio de cuenta por comando WhatsApp + configuración del usuario.
- Validación dura de monto, método de pago y fecha (regex + LLM fallback).
- Nuevo flujo de clasificación con consulta a historial de aprendizaje del usuario.
- IA en decisiones importantes + log append-only por usuario (`learning_log`).
- Comandos nuevos: `saldo`, `ingreso`, `transferir`, `usar cuenta`, `pendientes`, `mi historial`.

### Infraestructura (paralelo o post-fase)
- Migración a Functions v2 + `defineSecret`.
- Absorber webhook de Twilio (`twilioWebhook` HTTPS) con validación de firma `X-Twilio-Signature`.
- Tests con `firebase-functions-test`.
- Fix `getExpenseSummary` por mes (`Timestamp.fromDate`).
- Centralizar `isValidAudioType` y limpiar `voucherType` ignorado.

### Producto (largo plazo)
- Dashboard web con saldo y movimientos.
- Export CSV/Excel (gastos + movements + learning_log).
- Alertas de saldo bajo y presupuestos.
- Multi-usuario / familia y ML para clasificación están **fuera de la fase actual**.

---

**Última actualización:** 2026-05-12
**Versión:** 2.1.0
