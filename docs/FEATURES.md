# Features

Catálogo de capacidades del sistema, agrupadas por canal de entrada y por capa.

> Versión: 2.2.0 · Modelo NLU: `claude-sonnet-4-20250514` · Transcripción: `whisper-1`

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
| `ayuda`  | `help`, `comandos`, `commands`, `menu`; soporta `ayuda <tema>` |

`ayuda` lo resuelve `MessageParser.parseHelpCommand` (no `isCommandMessage`): acepta `ayuda` (menú) o `ayuda <tema>` (gastos/cuentas/saldo/pendientes/historial, con aliases y normalización de tildes). También se aceptan prefijos `/comando` (ej: `/resumen`).

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

## Cuentas y Wallet

Cada gasto pertenece a una **cuenta** (`users/{uid}/accounts`). La cuenta define la **moneda** por defecto y mantiene un **saldo** sincronizado.

- **Cuenta activa:** `AccountService.resolveActiveAccount` → sesión WhatsApp (override temporal) → `isPrimary` → primera cuenta → crea `Principal` PEN lazy.
- **Saldo como ledger:** la fuente de verdad es `users/{uid}/movements` (append-only). `accounts.saldo` es caché. Cada gasto/ingreso/transferencia se escribe en una **transacción Firestore** que actualiza saldo + movement + (para gasto) el expense, todo atómico.
- **Cambio de cuenta:** `usar cuenta <nombre>` (override de sesión con TTL), `cuenta actual`, `cuenta principal`.

## Clasificación (`InferenceService.classify`)

Orden estricto, match por **palabra/frase completa** sobre texto normalizado (sin diacríticos, minúsculas) — no `includes` substring:

1. `suggestions_ideas` de subcategorías → adopta subcategoría dueña + su categoría.
2. Nombre de subcategoría → su categoría.
3. Nombre de categoría → categoría, subcategoría `null`.
4. **Historial del usuario** (`learning_log`): se elige por **similitud de tokens** (overlap coef ≥ 0.5), priorizando correcciones explícitas (`user_correction`) sobre decisiones automáticas — ya no "la primera por recencia".
5. **LLM acotado a tu taxonomía** (solo si 1–4 fallan): **5a** reusa, sin costo, la categoría libre que el LLM ya devolvió en imagen/audio/fallback de texto y la mapea a tus categorías; **5b** si no hay hint o no mapea (camino regex), 1 llamada acotada a Anthropic que devuelve una categoría tuya o nada.
6. Sin match → `categoria: "sin_clasificar"`, `needsClassification: true`.

> **La categoría del LLM ya NO se descarta** (cambio § A.1 opción C). Se usa como **fallback acotado a tu taxonomía** tras el match exacto (1–3) e historial (4): el LLM nunca inventa categorías fuera de las tuyas, solo elige entre ellas o `sin_clasificar`. Costo controlado: en imagen/audio/fallback se reusa la llamada ya hecha; en el camino regex solo se llama si 1–4 fallan.

`matchedLevel` persistido en el expense (auditoría): `suggestion` (1) · `subcategory` (2) · `category` (3) · `history` (4) · `llm` (5) · `default` (6, = sin_clasificar). Pasos 1–3 = match por palabra completa exacto (sin plural/sinónimo/semántica).

### Método de pago (`resolvePaymentMethod`)
1. Token explícito en texto (`yape/plin/efectivo/transferencia/tarjeta` o método del usuario).
2. `explicitHint` (de imagen/Anthropic) que no mapea → `metodoPago: "otro"`, `needsReview: true`.
3. Sin señal → `efectivo` (fallback, sin review).

### Moneda (`resolveCurrency`)
- Override explícito en texto (`dólar/usd/$` → USD; `soles/sol/pen` → PEN).
- Si no, **heredada de la cuenta activa**. Se persiste `currencySource`.

### Fecha (`parseDateFromText` + fallback LLM)
- Regex: `hoy`, `ayer`, `anteayer`, `YYYY-MM-DD`, `DD-MM-YYYY`, `el N de <mes>`.
- Si el regex falla pero hay pista temporal (`hace`, `el lunes pasado`, etc.), **fallback a Anthropic** (`parseRelativeDate`) con la fecha del mensaje como referencia.
- Prioridad: fecha en texto (regex `dateSource: "regex"` / LLM `"llm"`) → fecha del mensaje (`"message"`).

## IA en decisiones (§ G.1)

Además de texto/imagen/audio, Anthropic interviene en:
- **Fecha relativa compleja:** `parseRelativeDate` cuando el regex no resuelve y hay pista temporal.
- **Método de pago ambiguo:** si un hint explícito no mapea, `disambiguatePaymentMethod` lo contrasta contra los métodos conocidos del usuario antes de marcar `otro`/`needsReview`.
- **Monto atípico:** comparación estadística contra la mediana de los últimos gastos del usuario; si supera 10× la mediana (con ≥8 de histórico) se marca `amountFlagged` y se avisa. **No bloquea** (flujo async): registra y marca para revisión vía `pendientes`.

### Voucher (`inferVoucherType`)
- `factura` | `recibo` | `nota_venta` si la descripción lo menciona; default `boleta`.

## Historial de aprendizaje (`learning_log`)

Append-only por usuario. Cada decisión de clasificación se registra; el comando `clasificar` añade una corrección (`user_correction`) que **retroalimenta** futuras clasificaciones (paso 4 de `classify`). Soft delete con `olvidar historial`.

- **Recuperación + scoring:** el paso 4 recupera candidatos por `learning_log.tokens` (Firestore `array-contains-any`, tokens ≥3 chars sin stopwords ES, máx 10) y luego **elige por solape de tokens** (overlap coef = |∩|/min, umbral 0.5), priorizando `user_correction`. Una corrección corta ("taxi") sigue aplicando a descripciones más largas que la contienen.
- **`clasificar <id>` — el ID es _case-sensitive_.** Los IDs de documento Firestore distinguen mayúsculas. Copia/pega el ID exacto que muestra `pendientes` (no lo reescribas a mano). `parseBotCommand` conserva su capitalización; `categoria`/`subcategoria` se normalizan a minúsculas.

## Idempotencia

`finalize` consulta `expenses` por `messageSid` antes de guardar. Si Twilio reintenta el webhook, el gasto no se duplica.

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

## Onboarding (primer contacto)

La primera vez que un usuario registrado escribe tras vincular su WhatsApp, el bot envía automáticamente la bienvenida (`buildOnboarding`) antes de procesar el mensaje. Detalles:

- **Idempotente:** `OnboardingService.tryClaimFirstContact` crea un marcador en `users/{uid}/sessions/onboarding`; un reintento de Twilio o un duplicado en la cola **no** vuelve a saludar.
- **Guard anti-spam:** si el usuario ya tiene entradas en `learning_log` (usuario previo a esta feature) se reclama el marcador en silencio y **no** se saluda.
- **No pierde el primer mensaje:** si el primer mensaje era solo un saludo/`ayuda`/vacío, la bienvenida ya respondió y se cierra. Si traía un gasto o comando real, se procesa normalmente después de saludar.

## Comandos disponibles

### `inicio`
Bienvenida (`buildOnboarding`, fuente única `src/config/help.ts`), personalizada con `user.name`. Mismo contenido que el onboarding automático (sin la línea de "número vinculado").

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

### `ayuda` / `ayuda <tema>`
Sistema de ayuda en dos niveles (fuente única `src/config/help.ts`, escalable: agregar un flujo = editar `HELP_TOPICS`):

- `ayuda` → menú compacto que lista todas las áreas con su pista y el comando para el detalle.
- `ayuda <tema>` → detalle con ejemplos. Temas: `gastos`, `cuentas`, `saldo`, `pendientes`, `historial` (cada uno con aliases, p. ej. `ayuda foto` → gastos, `ayuda dinero` → saldo).

Cada mensaje cabe en un solo WhatsApp (~1600 chars, verificado por tests).

### Cuentas y wallet
| Comando | Acción |
|---------|--------|
| `saldo` / `mi saldo` | Saldo de la cuenta activa |
| `saldos` / `saldo de cuentas` | Saldo de todas las cuentas |
| `movimientos` | Últimos movimientos del ledger |
| `ingreso <monto> <desc>` | Registra un ingreso (sube el saldo) |
| `transferir <monto> a <cuenta>` | Transferencia entre cuentas (misma moneda) |
| `usar cuenta <nombre>` | Cambia la cuenta activa de la sesión |
| `cuenta actual` / `cuenta principal` | Consulta / vuelve a la principal |

### Clasificación y aprendizaje
| Comando | Acción |
|---------|--------|
| `pendientes` | Lista gastos `sin_clasificar` o por revisar |
| `clasificar <id> <cat> [subcat]` | Reclasifica un gasto y lo aprende |
| `mi historial` / `aprendizajes` | Decisiones recientes |
| `olvidar historial` | Soft delete del historial de aprendizaje |

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
- Las `firestore.rules` (gestionadas por el web app `gastos`) bloquean `whatsapp_queue`; el bot usa Admin SDK (salta reglas).
- Las credenciales son secrets v2 (`defineSecret`), expuestas como `process.env.<NAME>` en runtime; no hay claves en código.

---

## Capacidades fuera del MVP (referencia, no implementadas)

- Múltiples usuarios por hogar / familia.
- Presupuestos y alertas.
- Dashboard web con auth.
- Export CSV/Excel.
- ML para predicción de gastos.

---

**Última actualización:** 2026-05-16
