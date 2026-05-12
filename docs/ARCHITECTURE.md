# Architecture

Documento técnico de referencia: diagrama, data flow, decisiones y deuda conocida.

## Objetivo

Cloud Function event-driven que procesa mensajes de WhatsApp (texto, imagen, audio) y los convierte en gastos estructurados en Firestore, con clasificación automática contra las categorías del usuario.

## Stack

- **Runtime:** Firebase Functions v1 (Node 20).
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
       │ webhook → backend Phase 1
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
| `processWhatsAppQueue` | Background | `firestore.document("whatsapp_queue/{id}").onCreate` | Procesar mensaje entrante |
| `healthCheck`          | HTTPS      | HTTP GET                                   | Status del servicio         |

---

## Data flow detallado

```
1. Usuario envía mensaje
2. Twilio recibe → llama webhook (sistema Phase 1, fuera de este repo)
3. Phase 1 crea documento en whatsapp_queue (status: pending)
4. Cloud Function trigger → onCreate
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

Variables resueltas en cascada: `functions.config().<scope>?.<key>` → `process.env.<NAME>`.

| Variable                | Servicio                  |
|-------------------------|---------------------------|
| `TWILIO_ACCOUNT_SID`    | Twilio API                |
| `TWILIO_AUTH_TOKEN`     | Twilio API                |
| `TWILIO_WHATSAPP_NUMBER`| Número emisor             |
| `ANTHROPIC_API_KEY`     | Claude texto + Vision     |
| `OPENAI_API_KEY`        | Whisper (audio)           |

> `functions.config()` está deprecado desde Functions v6. Migrar a `defineSecret` está en el roadmap.

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

### 4. `functions.config()` deprecado
Migrar a Functions v2 con `defineSecret` o variables de entorno de despliegue.

### 5. Sin tests automatizados
`firebase-functions-test` está en `devDependencies` pero no se usa. Añadir tests para `MessageParser`, `InferenceService` y el flujo principal.

### 6. Phase 1 acoplada
El webhook de Twilio que inserta en `whatsapp_queue` vive fuera de este repo. Considerar absorberlo aquí con una function HTTP (`twilioWebhook`) para reducir latencia y simplificar deploy.

### 7. Validación del webhook de Twilio
No se valida la firma `X-Twilio-Signature` (responsabilidad del Phase 1 actual). Si se absorbe el webhook, añadir validación.

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

### Pre-mejoras (corto plazo)
1. Migrar a Functions v2 + `defineSecret`.
2. Fix `getExpenseSummary` por mes.
3. Cache por invocación de categorías / payment methods.
4. Tests con `firebase-functions-test`.
5. Centralizar validación de tipos de media.

### Mejoras (medio plazo)
6. Absorber webhook de Twilio (`twilioWebhook` HTTPS function).
7. Validación de firma Twilio.
8. Separar funciones por canal.
9. Dashboard web.

### Features (largo plazo)
10. Presupuestos y alertas.
11. Export CSV/Excel.
12. ML para predicción de gastos.
13. Multi-usuario / familia.

---

**Última actualización:** 2026-05-12
**Versión:** 2.1.0
