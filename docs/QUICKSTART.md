# Quick Start

Puesta en marcha en ~10 minutos. Para configuración detallada ver [`SETUP.md`](SETUP.md).

## Prerrequisitos

- [ ] Node.js 22 (runtime de las funciones)
- [ ] Firebase CLI: `npm install -g firebase-tools`
- [ ] Proyecto Firebase con Firestore habilitado
- [ ] Cuenta Twilio con WhatsApp Sandbox activo
- [ ] API Key de Anthropic
- [ ] API Key de OpenAI (necesaria para audios)

## Pasos

### 1. Instalar dependencias
```bash
npm install
```

### 2. Login en Firebase y seleccionar proyecto
```bash
firebase login
# Edita .firebaserc y reemplaza "your-project-id"
```

### 3. Variables de entorno

Dos clases (NO se mezclan — secreto en `.env` rompe el deploy v2). Detalle: [`SETUP.md` §6](SETUP.md#paso-6--variables-de-entorno).

**No-secretas → `.env`** (versionado config, bundled al deploy):
```env
TWILIO_WEBHOOK_URL=https://us-central1-<proyecto>.cloudfunctions.net/twilioWebhook
TZ=America/Lima
WEBAPP_URL=https://expense-app-gepres.web.app/cuentas
```

**Secretas → Secret Manager** (las 5 credenciales, NUNCA en `.env`):
```bash
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_WHATSAPP_NUMBER
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set OPENAI_API_KEY
```
Emulador local: `.secret.local` con esas 5 claves (ver `SETUP.md` §6.3).

### 4. Desplegar
```bash
npm run deploy   # el predeploy corre lint+build+test (no hace falta build aparte)
```

## Probar el deploy

### Opción 1 — Health check
```bash
curl https://us-central1-<tu-proyecto>.cloudfunctions.net/healthCheck
```

Respuesta esperada:
```json
{
  "status": "ok",
  "timestamp": "2025-11-25T...",
  "service": "gastos-firebase-functions",
  "features": {
    "textParsing": true,
    "imageParsing": true,
    "categoryInference": true,
    "userValidation": true
  }
}
```

### Opción 2 — Insertar doc de prueba en Firestore

> **Importante:** primero crea un documento en `users/{uid}` con `whatsappPhone: "+51999999999"`. Sin usuario registrado, la función responde "No estás registrado..." y termina.

Colección `whatsapp_queue`:
```json
{
  "phoneNumber": "+51999999999",
  "message": "Gasté 50 soles en almuerzo",
  "webhookBody": {
    "MessageSid": "test-123",
    "From": "whatsapp:+51999999999",
    "Body": "Gasté 50 soles en almuerzo"
  },
  "status": "pending",
  "createdAt": "<Firestore Timestamp>",
  "retryCount": 0
}
```

Verificar:
- Logs: `npm run logs`
- Colección `expenses` debe contener el nuevo gasto (vinculado por `userId`).
- El estado de la cola debe pasar a `completed`.

## Tipos de mensaje soportados

| Tipo    | Pipeline                                                  |
|---------|-----------------------------------------------------------|
| Texto   | Regex (`message-parser.ts`) → fallback Anthropic          |
| Imagen  | Descarga Twilio → Anthropic Vision (`extractReceiptData`) |
| Audio   | Whisper (`transcription.service.ts`) → Anthropic          |

## Comandos NPM

```bash
npm run serve          # Emuladores Firebase
npm run smoke          # E2E en emulador (one-shot)
npm run build:watch    # Build incremental
npm run lint           # ESLint
npm run logs           # Tail logs producción
```

## Troubleshooting express

| Error                              | Acción                                                                 |
|------------------------------------|------------------------------------------------------------------------|
| `Anthropic API key not configured` | `firebase functions:secrets:set ANTHROPIC_API_KEY && npm run deploy`   |
| `Twilio credentials not configured`| Idem con `TWILIO_ACCOUNT_SID` y `TWILIO_AUTH_TOKEN`                    |
| `OpenAI API key not configured`    | Idem con `OPENAI_API_KEY`. Solo bloquea procesamiento de audio.       |
| Mensaje no procesa                 | Revisar `npm run logs` y status de doc en `whatsapp_queue`             |

## Siguientes pasos

1. Apuntar el webhook de Twilio (POST) a la URL de `twilioWebhook` — valida firma y encola solo. Ver [`SETUP.md`](SETUP.md) Paso 9.1.
2. Probar con WhatsApp real (sandbox).
3. Índices/reglas Firestore: **NO** desde este repo — los gestiona el proyecto `D:\PROYECTOS\gepres\gastos` (ver `SETUP.md` Paso 10/11).
4. Crear la cuenta del usuario en el **web app** (sección Cuentas) — el bot usa la cuenta canónica, no crea cuentas (`backfill:accounts` quedó obsoleto, ver `SETUP.md` §10.1).
5. Activar la alert policy una vez: `ops/README.md` (ver `SETUP.md` §9.2).

Documentación completa: [`README`](../README.md) · [`FEATURES`](FEATURES.md) · [`EXAMPLES`](EXAMPLES.md)
