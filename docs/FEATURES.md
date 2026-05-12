# Features

Catálogo de capacidades del sistema, agrupadas por canal de entrada y por capa.

> Versión: 2.1.0 · Modelo NLU: `claude-sonnet-4-20250514` · Transcripción: `whisper-1`

---

## Canales de entrada

| Canal  | Pipeline interno                                                | Latencia típica |
|--------|------------------------------------------------------------------|-----------------|
| Texto  | Regex (`message-parser.ts`) → fallback Anthropic                | ~500 ms – 2 s   |
| Imagen | Descarga Twilio → Anthropic Vision (`extractReceiptData`)       | ~5 – 8 s        |
| Audio  | Descarga Twilio → Whisper (`transcribeAudio`) → Anthropic       | ~6 – 10 s       |

Para cada canal el resto del pipeline es idéntico: inferencia → guardado → confirmación.

---

## Texto

### Formatos reconocidos por regex

```
50 almuerzo
25.50 taxi
100 supermercado

50 en almuerzo
25.50 en taxi

Gasté 50 en almuerzo
Pagué 25.50 soles en taxi
```

### Fallback a Anthropic
Si el regex falla, `AnthropicService.parseExpenseMessage` se encarga del parseo. Útil para mensajes con redacción libre o con información parcial.

### Comandos detectados antes del parseo
Si el texto exacto es uno de los siguientes, se trata como comando y no como gasto:

| Comando  | Aliases                                       |
|----------|-----------------------------------------------|
| `inicio` | `hola`, `hi`, `start`                          |
| `resumen`| `summary`, `total`, `ver gastos`               |
| `ayuda`  | `help`, `comandos`, `commands`                 |

También se aceptan prefijos `/comando` (ej: `/resumen`).

---

## Imagen (Anthropic Vision)

### Tipos soportados
- `image/jpeg`
- `image/png`
- `image/gif`
- `image/webp`

### Contenidos esperados
- Capturas de **Yape** y **Plin**.
- Boletas, facturas, recibos físicos fotografiados.
- Screenshots de transferencias bancarias.

### Datos extraídos por el modelo

```ts
{
  monto: number,
  comercio: string,
  descripcion: string,
  fecha: string,        // YYYY-MM-DD HH:MM:SS
  metodoPago: string,   // yape | plin | tarjeta | transferencia | efectivo
  moneda: string,       // PEN | USD | EUR | ...
  categoria: string,    // valor sugerido, se reinfiere contra Firestore
  subcategoria: string | null
}
```

El prompt completo está en `anthropic.service.ts:21-52`. Hay parseo defensivo de bloques ```` ```json ```` y validación de `monto`.

---

## Audio (Whisper + Anthropic)

### Formatos soportados
- `audio/ogg`
- `audio/mpeg`
- `audio/mp4`
- `audio/amr`
- `audio/wav`

### Flujo
1. Descarga autenticada del archivo desde Twilio (`MediaDownloader.downloadTwilioMedia`).
2. Whisper transcribe a español (`language: "es"`).
3. La transcripción se procesa con `AnthropicService.parseExpenseMessage` (igual que un mensaje de texto).
4. Inferencia + guardado.

Mensaje intermedio al usuario:
```
📝 Entendí: "<transcripción>"
⏳ Procesando...
```

---

## Inferencia (capa común a todos los canales)

`InferenceService` resuelve cinco campos antes de guardar. Lee siempre desde subcolecciones del usuario.

### Categoría (`inferCategory`)
1. Match por **nombre** de categoría.
2. Match por **nombre** de subcategoría.
3. Match por **keywords** (`suggestions_ideas`) de cada subcategoría.
4. Default: primera categoría del usuario, o literal `"otros"` si no hay categorías.

### Subcategoría (`inferSubCategory`)
Solo dentro de la categoría ya inferida:
1. Match por nombre.
2. Match por `suggestions_ideas`.
3. Default: primera subcategoría, o `null`.

### Método de pago (`inferPaymentMethod`)
1. Palabras clave en la descripción: `yape`, `plin`, `efectivo`, `transferencia`, `tarjeta`.
2. Match contra `users/{uid}/payment_methods`.
3. Default: primer método del usuario, o literal `"efectivo"`.

### Moneda (`inferCurrency`)
- `USD` si el texto contiene `dólar`, `dolar`, `usd` o `$`.
- `PEN` si contiene `soles`, `sol` o `pen`.
- Default: `PEN`.

### Voucher (`inferVoucherType`)
- `factura` | `recibo` | `nota_venta` si la descripción menciona la palabra.
- Default: `boleta`.

> El `voucherType` que devuelve Anthropic en `parseExpenseMessage` es ignorado en `index.ts`; siempre se reinfiere localmente. Decisión consciente para mantener la fuente de verdad en `InferenceService`.

---

## Validación de usuario

- Lookup en `users` por `whatsappPhone` (normalizado a `+51XXXXXXXXX`).
- Si no existe, la función responde con un mensaje pidiendo vincular el número desde la app y termina con `status: "completed"` (sin retry).
- El `phoneNumber` que llega del webhook **no** se guarda en el expense — se guarda `userId`.

---

## Cola y reintentos (`whatsapp_queue`)

| Estado       | Cuándo                                                        |
|--------------|---------------------------------------------------------------|
| `pending`    | Recién insertado, o re-encolado tras un fallo (retry)         |
| `processing` | La función tomó el doc                                        |
| `completed`  | Procesado OK, o terminado intencionalmente (sin contenido)    |
| `failed`     | 3 intentos fallidos. Se notifica al usuario por WhatsApp      |

Reintentos: máximo **3**. El `retryCount` se incrementa y el doc vuelve a `pending` para que el trigger lo retome.

---

## Comandos disponibles

### `inicio`
Mensaje de bienvenida personalizado con el `user.name`.

### `resumen`
Total + breakdown por categoría:
```
📊 Resumen de Gastos

💰 Total: S/ 305.00
📝 Cantidad: 8 gastos

Por categoría:
  • Comida: S/ 125.00
  • Transporte: S/ 80.00
  • ...
```

> **Nota técnica:** `getExpenseSummary` acepta un parámetro `month` que actualmente no funciona (compara string `YYYY-MM-DD` contra `Timestamp`). Ver `docs/ARCHITECTURE.md` → "Trampas conocidas".

### `ayuda`
Lista compacta de formatos y comandos.

---

## Persistencia

Esquema completo en [`../README.md`](../README.md#modelo-de-datos-firestore). Resumen:

- `users/{uid}` — usuario, con subcolecciones `categories` y `payment_methods`.
- `whatsapp_queue/{queueId}` — inbox de mensajes entrantes.
- `expenses/{expenseId}` — gastos vinculados por `userId` (no por `phoneNumber`).

Campos en español: `monto`, `categoria`, `descripcion`, `fecha`, `metodoPago`, `moneda`, `subcategoria`, `recurrente`, `reimbursementStatus`, `voucherType`.

---

## Mensajería (Twilio)

### Confirmación de gasto (texto)
```
✅ *Gasto registrado exitosamente!*

💰 Monto: 50.00
📝 Descripción: almuerzo
🏷️ Categoría: comida
💳 Método: efectivo
📂 Subcategoría: restaurantes

Escribe "resumen" para ver tus gastos.
```

### Confirmación de gasto (imagen)
```
✅ *Gasto registrado por imagen!*

💰 Monto: PEN 45.50
📝 Descripción: Pizza personal
🏷️ Categoría: comida
💳 Método: tarjeta
📂 Subcategoría: restaurantes
🏪 Comercio: Pizza Hut
```

### Confirmación de gasto (audio)
```
✅ *Gasto registrado por audio!*

💰 Monto: PEN 25.00
📝 Descripción: almuerzo
🏷️ Categoría: comida
💳 Método: efectivo
```

### Errores comunes enviados al usuario
- Usuario no registrado.
- Formato de gasto no reconocido (con ejemplos).
- Imagen no soportada o sin información extraíble.
- Audio no soportado o sin transcripción.
- Error después de 3 reintentos.

---

## Performance

| Operación               | Latencia objetivo |
|-------------------------|-------------------|
| Texto (regex)           | < 1 s             |
| Texto (Anthropic fallback) | 2 – 4 s        |
| Imagen (Vision)         | 5 – 8 s           |
| Audio (Whisper + parse) | 6 – 10 s          |
| Cold start              | 3 – 5 s           |
| Lecturas Firestore por mensaje | 1 user + 1..N categorías + 0..1 payment_methods |

Optimizaciones pendientes en el roadmap (ver `ARCHITECTURE.md`):
- Cache por invocación de categorías/payment_methods.
- Migración a Functions v2 para mejor cold start.

---

## Seguridad

- Sanitización de input (`MessageParser.sanitizeInput`: strip `<script>`, `<`, `>`; trim a 500 chars).
- Normalización de teléfono antes de match.
- `firestore.rules` bloquea acceso directo a `whatsapp_queue` y `expenses`.
- Las credenciales se resuelven vía `functions.config()` o env vars; no hay claves en código.

---

## Capacidades fuera del MVP (referencia, no implementadas)

- Múltiples usuarios por hogar / familia.
- Presupuestos y alertas.
- Dashboard web con auth.
- Export CSV/Excel.
- ML para predicción de gastos.

---

**Última actualización:** 2026-05-12
