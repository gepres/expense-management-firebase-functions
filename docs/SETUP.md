# Guía de Configuración Detallada

Para el camino corto ver [`QUICKSTART.md`](QUICKSTART.md). Este documento cubre cada paso con detalle y troubleshooting.

## Requisitos Previos

- Node.js 20+
- npm
- Firebase CLI: `npm install -g firebase-tools`
- Cuenta Firebase
- Cuenta Twilio con WhatsApp habilitado
- API Key de Anthropic Claude
- API Key de OpenAI (procesamiento de audio)

---

## Paso 1 — Firebase

### 1.1 Crear o seleccionar proyecto
```bash
firebase login
firebase projects:list
```
Crea un proyecto nuevo desde la consola si no tienes uno: https://console.firebase.google.com/

### 1.2 Apuntar `.firebaserc` al proyecto
```json
{
  "projects": { "default": "tu-proyecto-id" }
}
```

### 1.3 Habilitar Firestore
Console → Firestore Database → Create database → Production mode → región cercana.

---

## Paso 2 — Twilio

### 2.1 Credenciales
1. https://console.twilio.com/
2. Copia **Account SID** y **Auth Token** del Dashboard.

### 2.2 WhatsApp Sandbox
1. https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn
2. Activa el sandbox y envía el código desde tu WhatsApp.
3. Anota el número de envío (ej. `whatsapp:+14155238886`).

---

## Paso 3 — Anthropic

1. https://console.anthropic.com/
2. Crea una API Key (prefijo `sk-ant-`).
3. Verifica que tu plan da acceso a `claude-sonnet-4-20250514` (modelo usado para texto y visión).

---

## Paso 4 — OpenAI (Whisper)

> Solo necesario si quieres procesar audios. Sin esta clave la función fallará al recibir notas de voz, pero texto e imágenes funcionan.

1. https://platform.openai.com/api-keys
2. Crea una API Key.
3. El modelo usado es `whisper-1` con `language: "es"`.

---

## Paso 5 — Dependencias
```bash
npm install
```

---

## Paso 6 — Variables de entorno

### Desarrollo local
```bash
cp .env.example .env
```

Contenido:
```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=tu_token
TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886
ANTHROPIC_API_KEY=sk-ant-xxxxx
OPENAI_API_KEY=sk-xxxxx
```

### Producción (Firebase Functions Config)
```bash
firebase functions:config:set \
  twilio.account_sid="ACxxxxx" \
  twilio.auth_token="xxxxx" \
  twilio.whatsapp_number="whatsapp:+14155238886" \
  anthropic.api_key="sk-ant-xxxxx" \
  openai.api_key="sk-xxxxx"

firebase functions:config:get   # verificar
```

> Nota: `functions.config()` está deprecado en Functions v6. Si en el futuro se migra a Functions v2, reemplazar por `defineSecret` o variables de entorno.

---

## Paso 7 — Build
```bash
npm run build
```
Salida en `lib/`. Si hay errores de TS, revisa imports y tipos.

---

## Paso 8 — Pruebas locales con emuladores
```bash
npm run serve
```
UI de emuladores: http://localhost:4000

Inserta un documento en `whatsapp_queue` desde la UI para probar (ver [`QUICKSTART.md`](QUICKSTART.md#opción-2--insertar-doc-de-prueba-en-firestore)).

---

## Paso 9 — Deploy
```bash
npm run deploy
# o
firebase deploy --only functions
```

Salida esperada:
```
functions[processWhatsAppQueue(us-central1)] Successful create.
functions[healthCheck(us-central1)] Successful create.
Function URL (healthCheck): https://us-central1-<proyecto>.cloudfunctions.net/healthCheck
```

---

## Paso 10 — Índices de Firestore

Índices recomendados para queries de `expenses`:

| Colección | Campos                                |
|-----------|---------------------------------------|
| `expenses`| `userId` ASC, `createdAt` DESC        |
| `expenses`| `userId` ASC, `fecha` ASC             |
| `users`   | `whatsappPhone` ASC                   |

Cuando una query falla por falta de índice, Firebase te entrega un enlace directo para crearlo.

---

## Paso 11 — Reglas de Firestore

Versión actual (`firestore.rules`): bloquea acceso directo a `whatsapp_queue` y `expenses`. Solo Cloud Functions (admin SDK) pueden escribir.

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /whatsapp_queue/{queueId} {
      allow read, write: if false;
    }
    match /expenses/{expenseId} {
      allow read: if false;     // habilitar para dashboard
      allow write: if false;
    }
  }
}
```

Para el dashboard futuro: leer `expenses` solo si `request.auth.uid == resource.data.userId`.

---

## Paso 12 — Datos de usuario

Para que la función registre gastos, el `users/{uid}` correspondiente debe existir con `whatsappPhone` igual al teléfono normalizado (`+51XXXXXXXXX`).

Recomendado además, subcolecciones:
- `users/{uid}/categories/{categoryId}` — para inferir categoría/subcategoría.
- `users/{uid}/payment_methods/{methodId}` — para resolver métodos custom.

Si faltan estas subcolecciones, los defaults son: categoría `"otros"`, método `"efectivo"`, moneda `"PEN"`, voucher `"boleta"`.

---

## Comandos útiles

```bash
firebase functions:config:get
firebase functions:config:unset twilio.account_sid
npm run logs
npm run lint
npm run build:watch
firebase functions:list
```

---

## Troubleshooting

### `Anthropic API key not configured`
```bash
firebase functions:config:set anthropic.api_key="sk-ant-xxxxx"
npm run deploy
```

### `Twilio credentials not configured`
```bash
firebase functions:config:set \
  twilio.account_sid="ACxxxxx" \
  twilio.auth_token="xxxxx" \
  twilio.whatsapp_number="whatsapp:+14155238886"
npm run deploy
```

### `OpenAI API key not configured`
Solo afecta a audios. Idéntico al patrón anterior con `openai.api_key`.

### Función no se dispara
1. `npm run logs` y filtrar por `processWhatsAppQueue`.
2. Verifica que el doc en `whatsapp_queue` tenga `status: "pending"` al crearse.
3. Confirma que el trigger está activo en Firebase Console → Functions.

### `The query requires an index`
Firebase Functions devuelve el link directo en el error. Click → crear → esperar build (1–5 min).

### Usuario no encontrado
- Verifica que `users/{uid}.whatsappPhone` coincida con el número entrante normalizado (`+51XXXXXXXXX`, sin `whatsapp:`).
- El método de búsqueda está en `user.service.ts:findByWhatsAppPhone`.

---

## Monitoreo

- Functions dashboard: `https://console.firebase.google.com/project/<proyecto>/functions`
- Firestore usage: `.../firestore/usage`
- Billing: `.../usage`

## Free tier (referencia)

| Servicio        | Límite gratis                |
|-----------------|------------------------------|
| Cloud Functions | 2M invocaciones/mes          |
| Firestore       | 50K reads / 20K writes / día |
| Twilio Sandbox  | Solo números registrados     |
| Anthropic       | Según tu plan                |
| OpenAI Whisper  | Pay-per-use (no free tier)   |

---

## Soporte

- Firebase: https://firebase.google.com/support
- Twilio: https://support.twilio.com/
- Anthropic: https://support.anthropic.com/
- OpenAI: https://help.openai.com/
