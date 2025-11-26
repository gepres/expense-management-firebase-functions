# Guía de Configuración - Gastos Firebase Functions

## Requisitos Previos

- Node.js 18 o superior
- npm o yarn
- Firebase CLI instalada: `npm install -g firebase-tools`
- Cuenta de Firebase
- Cuenta de Twilio con WhatsApp habilitado
- API Key de Anthropic Claude

## Paso 1: Configurar Firebase

### 1.1 Crear/Seleccionar Proyecto Firebase

```bash
# Iniciar sesión en Firebase
firebase login

# Listar tus proyectos
firebase projects:list

# Si necesitas crear un nuevo proyecto, hazlo desde:
# https://console.firebase.google.com/
```

### 1.2 Actualizar Configuración del Proyecto

Edita `.firebaserc` y reemplaza `your-project-id` con tu ID de proyecto:

```json
{
  "projects": {
    "default": "tu-proyecto-id"
  }
}
```

### 1.3 Habilitar Firestore

```bash
# En la consola de Firebase:
# https://console.firebase.google.com/project/[tu-proyecto]/firestore
# 1. Ve a "Firestore Database"
# 2. Click "Create database"
# 3. Selecciona "Start in production mode"
# 4. Elige una ubicación cercana
```

## Paso 2: Configurar Twilio

### 2.1 Obtener Credenciales

1. Regístrate en [Twilio](https://www.twilio.com/)
2. Ve a tu [Console Dashboard](https://console.twilio.com/)
3. Copia tu **Account SID** y **Auth Token**

### 2.2 Habilitar WhatsApp

1. Ve a [Twilio WhatsApp Sandbox](https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn)
2. Sigue las instrucciones para activar el sandbox
3. Envía el código de activación desde tu WhatsApp
4. Copia el número de WhatsApp del sandbox (ejemplo: `whatsapp:+14155238886`)

## Paso 3: Configurar Anthropic

### 3.1 Obtener API Key

1. Regístrate en [Anthropic](https://www.anthropic.com/)
2. Ve a [API Settings](https://console.anthropic.com/settings/keys)
3. Crea una nueva API Key
4. Copia la clave (empieza con `sk-ant-`)

## Paso 4: Instalar Dependencias

```bash
# En el directorio del proyecto
npm install
```

## Paso 5: Configurar Variables de Entorno

### Para Desarrollo Local:

```bash
# Copiar archivo de ejemplo
cp .env.example .env

# Editar .env con tus credenciales
# Usa tu editor favorito:
notepad .env
# o
code .env
```

Completa con tus valores reales:

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=tu_token_real_aqui
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
ANTHROPIC_API_KEY=sk-ant-tu_clave_real_aqui
FIREBASE_PROJECT_ID=tu-proyecto-id
```

### Para Producción (Firebase):

```bash
firebase functions:config:set \
  twilio.account_sid="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  twilio.auth_token="tu_token_real_aqui" \
  twilio.whatsapp_number="whatsapp:+14155238886" \
  anthropic.api_key="sk-ant-tu_clave_real_aqui"
```

Verifica la configuración:

```bash
firebase functions:config:get
```

## Paso 6: Compilar el Proyecto

```bash
npm run build
```

Si hay errores de TypeScript, revisa los archivos de código.

## Paso 7: Probar Localmente (Opcional)

```bash
# Iniciar emuladores de Firebase
npm run serve
```

Abre la UI de emuladores en: http://localhost:4000

Para probar, agrega un documento a la colección `whatsapp_queue` desde la UI.

## Paso 8: Desplegar a Firebase

```bash
# Desplegar solo las funciones
npm run deploy

# O usar firebase CLI directamente
firebase deploy --only functions
```

Después del despliegue, verás las URLs de tus funciones:

```
✔  functions[processWhatsAppQueue(us-central1)] Successful create operation.
✔  functions[healthCheck(us-central1)] Successful create operation.
Function URL (healthCheck): https://us-central1-[project-id].cloudfunctions.net/healthCheck
```

## Paso 9: Configurar Índices de Firestore

Crea los índices necesarios en Firestore:

1. Ve a [Firestore Indexes](https://console.firebase.google.com/project/[tu-proyecto]/firestore/indexes)
2. Crea un índice compuesto para `expenses`:
   - Collection ID: `expenses`
   - Campos:
     - `phoneNumber` (Ascending)
     - `date` (Ascending)
   - Query scope: Collection

Si olvidas esto, Firebase te dará un enlace para crear el índice cuando ejecutes una consulta.

## Paso 10: Configurar Reglas de Firestore

Actualiza las reglas de seguridad:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Solo Cloud Functions pueden escribir en la cola
    match /whatsapp_queue/{queueId} {
      allow read, write: if false;
    }

    // Solo Cloud Functions pueden escribir gastos
    match /expenses/{expenseId} {
      allow read, write: if false;
    }
  }
}
```

## Paso 11: Probar la Integración Completa

### 11.1 Crear un Documento de Prueba

Usando la consola de Firebase o el emulador:

```javascript
// Colección: whatsapp_queue
{
  phoneNumber: "+51999999999",  // Tu número de WhatsApp
  message: "Gasté 50 soles en almuerzo",
  webhookBody: {
    MessageSid: "test-sid-12345",
    From: "whatsapp:+51999999999",
    Body: "Gasté 50 soles en almuerzo"
  },
  status: "pending",
  createdAt: firebase.firestore.Timestamp.now(),
  retryCount: 0
}
```

### 11.2 Verificar Logs

```bash
# Ver logs en tiempo real
firebase functions:log --only processWhatsAppQueue

# O en la consola:
# https://console.firebase.google.com/project/[tu-proyecto]/functions/logs
```

### 11.3 Probar desde WhatsApp

1. Asegúrate de haber activado el Twilio WhatsApp Sandbox
2. Envía un mensaje de WhatsApp al número de Twilio
3. Un webhook de tu aplicación (Phase 1) debe crear el documento en `whatsapp_queue`
4. La Cloud Function se ejecutará automáticamente
5. Recibirás una respuesta en WhatsApp

## Comandos Útiles

```bash
# Ver configuración actual
firebase functions:config:get

# Eliminar configuración
firebase functions:config:unset twilio.account_sid

# Ver logs
npm run logs

# Ejecutar lint
npm run lint

# Build en modo watch
npm run build:watch

# Ver uso de recursos
firebase functions:list
```

## Troubleshooting

### Error: "Anthropic API key not configured"

```bash
# Verifica que la configuración esté establecida
firebase functions:config:get anthropic.api_key

# Si no está, configúrala
firebase functions:config:set anthropic.api_key="sk-ant-xxxxx"

# Re-despliega
npm run deploy
```

### Error: "Twilio credentials not configured"

```bash
# Verifica ambas credenciales
firebase functions:config:get twilio

# Configura todas a la vez
firebase functions:config:set \
  twilio.account_sid="ACxxxxx" \
  twilio.auth_token="xxxxx" \
  twilio.whatsapp_number="whatsapp:+14155238886"
```

### Los mensajes no se procesan

1. Verifica los logs: `npm run logs`
2. Revisa el estado de los documentos en Firestore
3. Verifica que el trigger esté activo en Firebase Console
4. Asegúrate de que el documento tenga `status: "pending"`

### Error de índices de Firestore

Si ves: "The query requires an index"

1. Firebase te dará un enlace en el error
2. Haz click en el enlace para crear el índice automáticamente
3. Espera unos minutos a que el índice se construya

## Monitoreo

### Métricas Importantes

1. **Cloud Functions Dashboard:**
   - https://console.firebase.google.com/project/[tu-proyecto]/functions

2. **Firestore Usage:**
   - https://console.firebase.google.com/project/[tu-proyecto]/firestore/usage

3. **Billing:**
   - https://console.firebase.google.com/project/[tu-proyecto]/usage

### Límites del Free Tier

- **Cloud Functions:** 2M invocaciones/mes
- **Firestore:** 50K lecturas, 20K escrituras/día
- **Twilio:** Sandbox limitado a números registrados
- **Anthropic:** Según tu plan

## Siguientes Pasos

1. ✅ Configurar Firebase Functions (estás aquí)
2. 🔄 Integrar con webhook de Twilio (Phase 1)
3. 📊 Crear dashboard web para visualización
4. 🔔 Implementar notificaciones y alertas

## Soporte

- Firebase: https://firebase.google.com/support
- Twilio: https://support.twilio.com/
- Anthropic: https://support.anthropic.com/
