# Ejemplos de Uso

Mensajes soportados, respuestas del bot y snippets útiles. Para una vista funcional ver [`FEATURES.md`](FEATURES.md).

## Mensajes de texto

### Formatos básicos (regex)

```
50 almuerzo                  → monto: 50,     descripcion: "almuerzo"
25.50 taxi                   → monto: 25.50,  descripcion: "taxi"
100 supermercado             → monto: 100,    descripcion: "supermercado"

50 en almuerzo               → monto: 50,     descripcion: "almuerzo"
Gasté 50 en almuerzo         → monto: 50,     descripcion: "almuerzo"
Pagué 25.50 soles en taxi    → monto: 25.50,  descripcion: "taxi"
```

### Con método de pago en el texto

```
50 almuerzo con yape         → metodoPago: "yape"
30 taxi en efectivo          → metodoPago: "efectivo"
100 compras con plin         → metodoPago: "plin"
80 transporte transferencia  → metodoPago: "transferencia"
200 ropa con tarjeta         → metodoPago: "tarjeta"
```

### Con moneda explícita

```
50 USD comida                → moneda: "USD"
$30 cafe                     → moneda: "USD"
200 soles luz                → moneda: "PEN"
```

### Fallback Anthropic (mensajes complejos)

Cuando el regex no acierta, el mensaje pasa a `AnthropicService.parseExpenseMessage`:

```
"Hoy me gasté unos 45 luquitas en pizza"
"Salieron 120 entre uber y propina"
"Por la consulta médica me cobraron 90"
```

## Comandos

| Input                                   | Acción         |
|-----------------------------------------|----------------|
| `inicio`, `hola`, `hi`, `start`         | Bienvenida     |
| `resumen`, `summary`, `total`, `ver gastos` | Resumen      |
| `ayuda`, `help`, `comandos`, `commands` | Lista de ayuda |

Prefijos `/comando` también funcionan: `/resumen`, `/ayuda`.

### Cuentas, wallet y clasificación

```
saldo                          → saldo de la cuenta activa
saldos                         → saldo de todas las cuentas
movimientos                    → últimos movimientos
ingreso 1500 sueldo            → +1500 en la cuenta activa
transferir 200 a negocio       → transferencia entre cuentas (misma moneda)
usar cuenta negocio            → activa "negocio" durante la conversación
cuenta actual                  → muestra la cuenta activa
cuenta principal               → vuelve a la principal
pendientes                     → lista gastos sin_clasificar / a revisar
clasificar abc123 comida cena  → reclasifica el gasto abc123 y lo aprende
mi historial                   → decisiones recientes
olvidar historial              → borra el historial de aprendizaje
```

### Respuesta a `resumen`

```
📊 *Resumen de Gastos*

💰 Total: S/ 305.00
📝 Cantidad: 8 gastos

*Por categoría:*
  • comida: S/ 125.00
  • transporte: S/ 80.00
  • entretenimiento: S/ 50.00
  • salud: S/ 50.00
```

### Respuesta a `ayuda`

```
🤖 *Asistente de Gastos Inteligente*

📝 *Registrar gasto:*
• "50 almuerzo"
• "25.50 taxi con yape"
• "Gasté 100 en supermercado"

📷 *Registrar con foto:*
• Comprobante de pago
• Captura de Yape/Plin
• Boleta o factura

📊 *Ver resumen:*
Escribe "resumen"

¡Empieza a registrar tus gastos ahora! 💸
```

## Respuestas del sistema

### Gasto registrado (texto)

```
✅ *Gasto registrado exitosamente!*

💰 Monto: 50.00
📝 Descripción: almuerzo
🏷️ Categoría: comida
💳 Método: efectivo

Escribe "resumen" para ver tus gastos.
```

### Gasto registrado (imagen)

```
✅ *Gasto registrado por imagen!*

💰 Monto: PEN 45.50
📝 Descripción: Pizza personal
🏷️ Categoría: comida
💳 Método: tarjeta
📂 Subcategoría: restaurantes
🏪 Comercio: Pizza Hut
```

### Error: mensaje no reconocido

```
❌ No pude entender el formato del gasto.

💡 Formatos correctos:
• "50 almuerzo"
• "25.50 taxi con yape"
• "Gasté 15 soles en bodega"

Escribe "ayuda" para más información.
```

### Error: usuario no registrado

```
❌ No estás registrado en la plataforma.

Por favor vincula tu número de WhatsApp desde tu perfil en la aplicación.
```

### Error: imagen sin información extraíble

```
❌ No pude extraer información de la imagen. Asegúrate de enviar un comprobante o captura de pago clara.
```

### Error: audio no transcribible

```
❌ No pude transcribir el audio. Asegúrate de hablar claro y en español.
```

## Documentos de Firestore (ejemplos)

### `users/{uid}` con sub-colecciones

```json
// users/abc123
{
  "name": "Genaro Pretill",
  "email": "user@example.com",
  "whatsappPhone": "+51999999999",
  "whatsappLinkedAt": "2025-11-01T12:00:00.000Z"
}

// users/abc123/categories/comida
{
  "nombre": "Comida",
  "subcategorias": [
    {
      "id": "restaurantes",
      "nombre": "Restaurantes",
      "suggestions_ideas": ["almuerzo", "cena", "pizza", "pollo a la brasa"]
    },
    {
      "id": "delivery",
      "nombre": "Delivery",
      "suggestions_ideas": ["pedidos ya", "rappi", "didi food"]
    }
  ]
}

// users/abc123/payment_methods/yape
{ "nombre": "Yape" }
```

### `whatsapp_queue/{queueId}` (entrada)

```json
{
  "phoneNumber": "+51999999999",
  "message": "Gasté 50 soles en almuerzo",
  "webhookBody": {
    "MessageSid": "SM123456789",
    "From": "whatsapp:+51999999999",
    "Body": "Gasté 50 soles en almuerzo",
    "NumMedia": "0"
  },
  "status": "pending",
  "createdAt": "<Timestamp>",
  "retryCount": 0
}
```

### `expenses/{expenseId}` (resultado)

```json
{
  "userId": "abc123",
  "accountId": "acc_principal",
  "monto": 50,
  "categoria": "comida",
  "subcategoria": "restaurantes",
  "descripcion": "almuerzo",
  "fecha": "<Timestamp 2025-11-25 13:42:00>",
  "metodoPago": "efectivo",
  "moneda": "PEN",
  "recurrente": false,
  "reimbursementStatus": "pending",
  "voucherType": "boleta",
  "matchedTerm": "almuerzo",
  "matchedLevel": "suggestion",
  "currencySource": "account",
  "dateSource": "message",
  "paymentMethodSource": "fallback",
  "needsClassification": false,
  "needsReview": false,
  "messageSid": "SM123456789",
  "createdAt": "<Timestamp>",
  "updatedAt": "<Timestamp>"
}
```

### `users/{uid}/accounts/{accountId}`

```json
{
  "nombre": "Principal",
  "isPrimary": true,
  "moneda": "PEN",
  "tipo": "personal",
  "saldo": 1250.50,
  "saldoInicial": 0,
  "createdAt": "<Timestamp>",
  "updatedAt": "<Timestamp>"
}
```

### `users/{uid}/movements/{movementId}` (ledger)

```json
{
  "accountId": "acc_principal",
  "tipo": "gasto",
  "monto": 50,
  "signoEfectivo": -1,
  "expenseId": "exp_789",
  "descripcion": "almuerzo",
  "fecha": "<Timestamp>",
  "saldoAnterior": 1300.50,
  "saldoNuevo": 1250.50,
  "createdAt": "<Timestamp>"
}
```

### `users/{uid}/learning_log/{entryId}`

```json
{
  "expenseId": "exp_789",
  "type": "classification",
  "input": { "raw": "50 almuerzo", "normalized": "50 almuerzo", "channel": "text" },
  "decision": { "field": "categoria", "value": "comida", "source": "regex", "matchedTerm": "almuerzo" },
  "tokens": ["almuerzo"],
  "createdAt": "<Timestamp>"
}
```

## Snippets

### Encolar un mensaje desde otro servicio

```javascript
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();

async function enqueueWhatsAppMessage(phoneNumber, message) {
  return db.collection("whatsapp_queue").add({
    phoneNumber,
    message,
    webhookBody: {
      MessageSid: `SM${Date.now()}`,
      From: `whatsapp:${phoneNumber}`,
      Body: message,
    },
    status: "pending",
    createdAt: admin.firestore.Timestamp.now(),
    retryCount: 0,
  });
}
```

### Leer gastos recientes de un usuario

```javascript
async function getRecentExpenses(userId, limit = 10) {
  const snap = await db
    .collection("expenses")
    .where("userId", "==", userId)
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
```

### Total por categoría (vigente)

```javascript
async function getTotalByCategory(userId) {
  const snap = await db.collection("expenses").where("userId", "==", userId).get();
  const byCategory = {};
  let total = 0;
  snap.forEach(doc => {
    const { categoria, monto } = doc.data();
    byCategory[categoria] = (byCategory[categoria] || 0) + monto;
    total += monto;
  });
  return { byCategory, total, count: snap.size };
}
```

### Total por mes (workaround, ver "Trampas conocidas" en ARCHITECTURE.md)

```javascript
const { Timestamp } = require("firebase-admin/firestore");

async function getMonthlyTotal(userId, year, month /* 1-12 */) {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  const snap = await db
    .collection("expenses")
    .where("userId", "==", userId)
    .where("fecha", ">=", Timestamp.fromDate(start))
    .where("fecha", "<",  Timestamp.fromDate(end))
    .get();
  let total = 0;
  snap.forEach(d => total += d.data().monto);
  return total;
}
```

## Testing

### Health check vía cURL

```bash
curl https://us-central1-<tu-proyecto>.cloudfunctions.net/healthCheck
```

### Probar localmente

```bash
npm run serve         # build + emuladores
# Crear doc en whatsapp_queue desde la UI: http://localhost:4000
```

## Escenarios end-to-end

```
Usuario → "30 desayuno"
Bot    → ✅ Gasto registrado (comida, 30.00)

Usuario → "20 taxi al trabajo"
Bot    → ✅ Gasto registrado (transporte, 20.00)

Usuario → [foto de boleta de Pizza Hut S/ 45.50]
Bot    → ⏳ Procesando imagen...
Bot    → ✅ Gasto registrado por imagen! ...

Usuario → [nota de voz: "gasté veinte soles en uber"]
Bot    → 🎤 Procesando audio...
Bot    → 📝 Entendí: "gasté veinte soles en uber"
Bot    → ✅ Gasto registrado por audio! ...

Usuario → "resumen"
Bot    → 📊 Resumen de Gastos ...
```
