# Ejemplos de Uso

## Mensajes de Gastos Soportados

### Formato Básico

```
Gasté 25 soles en almuerzo
→ Monto: 25, Categoría: comida, Descripción: almuerzo
```

```
50 en taxi
→ Monto: 50, Categoría: transporte, Descripción: taxi
```

```
Compré medicina por 80
→ Monto: 80, Categoría: salud, Descripción: medicina
```

### Variaciones de Formato

```
Pagué 15 soles de café
→ Monto: 15, Categoría: comida, Descripción: café
```

```
120 soles en supermercado
→ Monto: 120, Categoría: hogar, Descripción: supermercado
```

```
Gasto de 35 en Netflix
→ Monto: 35, Categoría: entretenimiento, Descripción: Netflix
```

```
200 S/. en luz
→ Monto: 200, Categoría: servicios, Descripción: luz
```

## Categorías Automáticas

El sistema usa Anthropic Claude para categorizar automáticamente:

| Palabra Clave | Categoría | Ejemplos |
|--------------|-----------|----------|
| almuerzo, cena, café, restaurante | comida | "25 en almuerzo" |
| taxi, uber, gasolina, estacionamiento | transporte | "30 en taxi" |
| Netflix, cine, juegos, concierto | entretenimiento | "40 en Netflix" |
| doctor, medicina, farmacia | salud | "80 en medicina" |
| supermercado, muebles, decoración | hogar | "150 en supermercado" |
| luz, agua, internet, teléfono | servicios | "100 en luz" |
| otros | otros | gastos no categorizados |

## Comandos Disponibles

### Resumen de Gastos

```
resumen
summary
total
```

**Respuesta:**
```
📊 *Resumen de Gastos*

💰 Total: S/ 305.00
📝 Cantidad de gastos: 5

*Por categoría:*
  • comida: S/ 65.00
  • transporte: S/ 80.00
  • entretenimiento: S/ 40.00
  • salud: S/ 120.00
```

### Ayuda

```
ayuda
help
comandos
commands
```

**Respuesta:**
```
🤖 *Comandos Disponibles*

*Registrar gasto:*
Simplemente envía un mensaje como:
  • "Gasté 25 soles en almuerzo"
  • "50 en taxi"
  • "Compré medicina por 80"

*Comandos:*
  • resumen - Ver resumen de gastos
  • ayuda - Mostrar este mensaje

¡Empieza a registrar tus gastos! 💸
```

## Respuestas del Sistema

### Gasto Registrado Exitosamente

**Input:** "Gasté 45 soles en pizza"

**Output:**
```
✅ *Gasto registrado exitosamente*

💰 Monto: S/ 45.00
📁 Categoría: comida
📝 Descripción: pizza
📅 Fecha: 2025-11-25

¡Tu gasto ha sido guardado! 🎉
```

### Error: Mensaje No Reconocido

**Input:** "Hola cómo estás"

**Output:**
```
❌ *Error al procesar tu mensaje*

No se pudo identificar información de gasto en el mensaje

Por favor, intenta de nuevo con un formato como:
- "Gasté 25 soles en almuerzo"
- "50 en taxi"
- "Compré medicina por 80"
```

## Ejemplos de Código

### Crear Documento en whatsapp_queue (JavaScript)

```javascript
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

async function addToQueue(phoneNumber, message) {
  const queueDoc = {
    phoneNumber: phoneNumber,
    message: message,
    webhookBody: {
      MessageSid: `SM${Date.now()}`,
      From: `whatsapp:${phoneNumber}`,
      Body: message
    },
    status: 'pending',
    createdAt: admin.firestore.Timestamp.now(),
    retryCount: 0
  };

  const docRef = await db.collection('whatsapp_queue').add(queueDoc);
  console.log('Added to queue:', docRef.id);
  return docRef.id;
}

// Uso
addToQueue('+51999999999', 'Gasté 50 soles en almuerzo');
```

### Consultar Gastos (JavaScript)

```javascript
async function getExpenses(phoneNumber, limit = 10) {
  const snapshot = await db.collection('expenses')
    .where('phoneNumber', '==', phoneNumber)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  const expenses = [];
  snapshot.forEach(doc => {
    expenses.push({
      id: doc.id,
      ...doc.data()
    });
  });

  return expenses;
}

// Uso
const expenses = await getExpenses('+51999999999');
console.log(JSON.stringify(expenses, null, 2));
```

### Calcular Total por Categoría (JavaScript)

```javascript
async function getTotalByCategory(phoneNumber) {
  const snapshot = await db.collection('expenses')
    .where('phoneNumber', '==', phoneNumber)
    .get();

  const totals = {};
  let grandTotal = 0;

  snapshot.forEach(doc => {
    const data = doc.data();
    const category = data.category;
    const amount = data.amount;

    totals[category] = (totals[category] || 0) + amount;
    grandTotal += amount;
  });

  return {
    byCategory: totals,
    total: grandTotal,
    count: snapshot.size
  };
}

// Uso
const summary = await getTotalByCategory('+51999999999');
console.log(summary);
// {
//   byCategory: { comida: 65, transporte: 80, ... },
//   total: 305,
//   count: 5
// }
```

## Testing con cURL

### Probar Health Check

```bash
curl https://us-central1-[tu-proyecto].cloudfunctions.net/healthCheck
```

**Respuesta:**
```json
{
  "status": "ok",
  "timestamp": "2025-11-25T12:00:00.000Z",
  "service": "gastos-firebase-functions"
}
```

## Testing Manual en Firebase Console

### 1. Agregar Documento de Prueba

Ve a Firestore en la consola y agrega un documento:

**Colección:** `whatsapp_queue`

**Documento:**
```json
{
  "phoneNumber": "+51999999999",
  "message": "Gasté 50 soles en almuerzo",
  "webhookBody": {
    "MessageSid": "SM123456789",
    "From": "whatsapp:+51999999999",
    "Body": "Gasté 50 soles en almuerzo"
  },
  "status": "pending",
  "createdAt": "[Timestamp]",
  "retryCount": 0
}
```

### 2. Observar Logs

Ve a Functions → Logs en Firebase Console o ejecuta:

```bash
firebase functions:log --only processWhatsAppQueue
```

### 3. Verificar Resultado

1. El documento en `whatsapp_queue` debe cambiar a `status: "completed"`
2. Debe aparecer un nuevo documento en la colección `expenses`
3. Deberías recibir un mensaje de WhatsApp de confirmación

## Casos de Uso Reales

### Escenario 1: Usuario Registra Varios Gastos

```
Usuario → "Gasté 30 en desayuno"
Sistema → ✅ Gasto registrado (comida, S/ 30.00)

Usuario → "20 en taxi al trabajo"
Sistema → ✅ Gasto registrado (transporte, S/ 20.00)

Usuario → "100 en supermercado"
Sistema → ✅ Gasto registrado (hogar, S/ 100.00)

Usuario → "resumen"
Sistema → 📊 Total: S/ 150.00
         • comida: S/ 30.00
         • transporte: S/ 20.00
         • hogar: S/ 100.00
```

### Escenario 2: Mensaje No Reconocido

```
Usuario → "Hola"
Sistema → ❌ No se pudo identificar información de gasto

Usuario → "qué tal"
Sistema → ❌ No se pudo identificar información de gasto

Usuario → "ayuda"
Sistema → 🤖 Comandos Disponibles [muestra ayuda]
```

### Escenario 3: Formato Variado

```
Usuario → "Pagué 45 soles de pizza"
Sistema → ✅ Gasto registrado (comida, S/ 45.00)

Usuario → "150 S/. en gasolina"
Sistema → ✅ Gasto registrado (transporte, S/ 150.00)

Usuario → "Gasto de 25 en café"
Sistema → ✅ Gasto registrado (comida, S/ 25.00)
```

## Estructura de Datos en Firestore

### Ejemplo de Documento en `expenses`

```json
{
  "phoneNumber": "+51999999999",
  "amount": 45,
  "category": "comida",
  "description": "pizza",
  "date": "2025-11-25",
  "createdAt": {
    "_seconds": 1732550400,
    "_nanoseconds": 0
  },
  "updatedAt": {
    "_seconds": 1732550400,
    "_nanoseconds": 0
  }
}
```

### Ejemplo de Documento en `whatsapp_queue` (Completado)

```json
{
  "phoneNumber": "+51999999999",
  "message": "Gasté 50 soles en almuerzo",
  "webhookBody": {
    "MessageSid": "SM123456789",
    "From": "whatsapp:+51999999999",
    "Body": "Gasté 50 soles en almuerzo"
  },
  "status": "completed",
  "createdAt": {
    "_seconds": 1732550400,
    "_nanoseconds": 0
  },
  "processedAt": {
    "_seconds": 1732550405,
    "_nanoseconds": 0
  },
  "retryCount": 0
}
```

## Métricas y Monitoreo

### Consultas Útiles en Firestore

```javascript
// Total de gastos procesados
db.collection('whatsapp_queue')
  .where('status', '==', 'completed')
  .get()
  .then(snapshot => console.log('Procesados:', snapshot.size));

// Gastos fallidos
db.collection('whatsapp_queue')
  .where('status', '==', 'failed')
  .get()
  .then(snapshot => console.log('Fallidos:', snapshot.size));

// Gastos del día
const today = new Date().toISOString().split('T')[0];
db.collection('expenses')
  .where('date', '==', today)
  .get()
  .then(snapshot => {
    let total = 0;
    snapshot.forEach(doc => total += doc.data().amount);
    console.log('Total del día:', total);
  });
```

## Tips y Mejores Prácticas

1. **Formato flexible:** El sistema entiende múltiples formatos gracias a Claude
2. **Categorización automática:** No necesitas especificar la categoría
3. **Fecha automática:** Si no mencionas fecha, usa la fecha actual
4. **Comandos simples:** `resumen` para ver tus gastos rápidamente
5. **Lenguaje natural:** Escribe como hablarías normalmente
