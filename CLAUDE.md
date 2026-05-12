# CLAUDE.md — Guía operativa para Claude Code

Este archivo orienta a futuras sesiones de Claude Code dentro de **gastos-firebase-functions**. Leerlo antes de tocar código o documentación.

## 1. ¿Qué es este proyecto?

Asistente de gastos por WhatsApp. Cloud Function que se dispara `onCreate` sobre `whatsapp_queue` en Firestore, procesa el mensaje (texto, imagen o audio), infiere categoría/método de pago/moneda y guarda el gasto en `expenses`. Responde por WhatsApp vía Twilio.

- Runtime: **Node 20**, **Firebase Functions v1**, **TypeScript 5.3** (strict).
- NLU: **Anthropic Claude `claude-sonnet-4-20250514`** (texto + Vision).
- Audio: **OpenAI Whisper (`whisper-1`)**, idioma `es`.
- Mensajería: **Twilio WhatsApp**.

## 2. Mapa del código

```
src/index.ts                          ← trigger + orquestación (texto/imagen/audio)
src/types/index.ts                    ← interfaces compartidas
src/services/
  anthropic.service.ts                ← parseExpenseMessage + extractReceiptData (Vision)
  transcription.service.ts            ← Whisper, escribe a tmpfile y limpia
  inference.service.ts                ← infer categoría/subcat/método/moneda/voucher
  expense.service.ts                  ← saveExpense, getExpenseSummary
  user.service.ts                     ← lookup por whatsappPhone
  twilio.service.ts                   ← sendMessage
src/utils/
  message-parser.ts                   ← normalize, sanitize, regex de gasto, comandos
  media-downloader.ts                 ← descarga media de Twilio con basic auth
```

Punto de entrada lógico: `processWhatsAppQueue` en `src/index.ts:20`.

## 3. Convenciones del repo

- **Idioma de los mensajes/UX:** español (Perú). Soles, Yape, Plin, "bodega", etc.
- **Identidad del gasto:** vinculado por `userId`, **no** por `phoneNumber`. El teléfono solo resuelve al usuario.
- **Nombres de campos en Firestore:** español (`monto`, `categoria`, `descripcion`, `fecha`, `metodoPago`, `moneda`, `voucherType`). Mantener consistencia al añadir campos.
- **Fechas:** `expense.fecha` se guarda como `Timestamp`. Si llega `YYYY-MM-DD` se le agrega hora actual (`expense.service.ts:18-29`).
- **Inferencia ordenada:** intentamos primero las subcolecciones del usuario (`users/{uid}/categories`, `users/{uid}/payment_methods`). Si no hay match, defaults: categoría `"otros"`, método `"efectivo"`, moneda `"PEN"`, voucher `"boleta"`.
- **Retry policy:** máximo 3 intentos. Tras el tercer fallo se marca `failed` y se notifica al usuario.
- **Logging:** `functions.logger.{info,warn,error}`. Emojis ya presentes en logs son intencionales para legibilidad — respetarlos al modificar.

## 4. Decisiones que ya están tomadas (no rediscutir sin pedirlo)

- Texto: **regex primero**, Anthropic como fallback. Es más barato y más rápido.
- Imágenes y audio: siempre van por modelo (no regex).
- `firebase-functions/v1` por compatibilidad histórica. Migrar a `v2` está en el roadmap pero **no** se hace en cambios incidentales.
- `functions.config()` sigue en uso aunque está deprecado en v6. Si el cambio toca esa zona, mantener compatibilidad con `process.env.*` como fallback (ya implementado en cada service).

## 5. Antes de cambiar código

1. **Compilación:** `npm run build`. Bloquea el deploy si falla.
2. **Lint:** `npm run lint` (config: Google + TS plugin). Lint se ejecuta en `predeploy` (`firebase.json`).
3. **Emulador local:** `npm run serve` levanta solo Functions. Para probar manualmente, crear un doc en `whatsapp_queue` con `status: "pending"` y `retryCount: 0`.
4. **No hay tests automatizados todavía.** `firebase-functions-test` está instalado pero sin uso. Si añades lógica no trivial, considera dejarla testeable.

## 6. Secretos y configuración

Cinco credenciales son necesarias:

| Variable                | Origen                        |
|-------------------------|-------------------------------|
| `TWILIO_ACCOUNT_SID`    | Twilio Console                |
| `TWILIO_AUTH_TOKEN`     | Twilio Console                |
| `TWILIO_WHATSAPP_NUMBER`| Twilio Sandbox o número productivo |
| `ANTHROPIC_API_KEY`     | console.anthropic.com         |
| `OPENAI_API_KEY`        | platform.openai.com (Whisper) |

Resolución en cada service: `functions.config().<scope>?.<key>` ◯ `process.env.<NAME>`. No hardcodear nunca.

## 7. Trampas conocidas

- **`getExpenseSummary` con `month`** (`expense.service.ts:114-118`): construye strings `YYYY-MM-01`/`-31` y los compara con `fecha` que es `Timestamp`. La comparación nunca matchea. Si tocas resúmenes, arréglalo a `Timestamp.fromDate(...)` o documenta el bug.
- **`extractMessageText`** (`message-parser.ts:30-32`) hace `toLowerCase()` y no se usa en el flujo principal (en `index.ts` se sanitiza pero no se lowercasea). Cuidado con regresiones si lo introduces en el pipeline.
- **`TranscriptionService.isValidAudioType`** está duplicado en `MediaDownloader.isValidAudioType`. Si añades formatos, actualiza **ambos**.
- **`extractReceiptData`** confía en que Anthropic devuelva JSON. Hay parseo defensivo de ```` ```json ```` pero un JSON malformado tirará el flujo al `catch`. Está bien — el retry lo cubre — pero ojo si cambias el prompt.
- **`AnthropicService.parseExpenseMessage`** retorna `voucherType: "boleta"` por defecto en su `expenseData`. El caller en `index.ts` **ignora** ese valor y vuelve a inferir con `InferenceService.inferVoucherType`. No es un bug, pero es ruido — limpiar en la próxima refactor.
- **Mensaje sin texto y sin media:** se marca `completed` con `error: "No content to process"`. No envía respuesta al usuario; decisión consciente para no spamear.

## 8. Estilo de cambios

- Cambios pequeños y enfocados. Este repo no tiene tests, así que diff grandes son riesgosos.
- No añadas comentarios que solo describan *qué* hace el código (los nombres ya lo hacen). Reserva comentarios para *por qué* — invariantes, workarounds, decisiones de prompt.
- No reformatees archivos completos por gusto. ESLint marca lo que importa.
- Documentación viva en `docs/`. Si añades una feature nueva, actualiza `docs/FEATURES.md` y, si corresponde, `docs/EXAMPLES.md` y este `CLAUDE.md`.

## 9. Roadmap próximo (contexto para "pre mejoras")

Ver sección final del `README.md`. Items prioritarios:

1. Migración a Functions v2 + `defineSecret`.
2. Fix de `getExpenseSummary` por mes.
3. Cache por-invocación de categorías y métodos de pago del usuario.
4. Tests con `firebase-functions-test`.
5. Webhook directo de Twilio (saltar la fase de queue para latencia).

## 10. Comandos útiles

```bash
npm run build           # tsc → lib/
npm run lint            # eslint
npm run serve           # build + emuladores
npm run deploy          # firebase deploy --only functions
npm run logs            # tail logs producción
firebase functions:config:get   # ver config remota
```
