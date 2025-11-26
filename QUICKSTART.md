# 🚀 Quick Start Guide

Guía rápida para poner en funcionamiento el proyecto en **10 minutos**.

## ✅ Checklist Pre-requisitos

- [ ] Node.js 18+ instalado
- [ ] Cuenta Firebase creada
- [ ] Firebase CLI instalado: `npm install -g firebase-tools`
- [ ] Cuenta Twilio con WhatsApp Sandbox activo
- [ ] API Key de Anthropic

## 📋 Pasos Rápidos

### 1️⃣ Instalar Dependencias (1 min)

```bash
npm install
```

### 2️⃣ Configurar Firebase (2 min)

```bash
# Login a Firebase
firebase login

# Editar .firebaserc con tu project ID
# Reemplaza "your-project-id" con tu ID real
```

### 3️⃣ Configurar Variables de Entorno (3 min)

**Opción A: Desarrollo Local (.env)**

```bash
cp .env.example .env
# Editar .env con tus credenciales reales
```

**Opción B: Producción (Firebase Config)**

```bash
firebase functions:config:set \
  twilio.account_sid="ACxxxxx" \
  twilio.auth_token="xxxxx" \
  twilio.whatsapp_number="whatsapp:+14155238886" \
  anthropic.api_key="sk-ant-xxxxx"
```

### 4️⃣ Compilar y Desplegar (4 min)

```bash
# Compilar TypeScript
npm run build

# Desplegar a Firebase
npm run deploy
```

Espera a que termine el despliegue...

✅ **¡Listo!** Tus funciones están desplegadas.

## 🧪 Probar la Instalación

### Opción 1: Desde Firebase Console

1. Ve a Firestore en Firebase Console
2. Crea un documento en `whatsapp_queue`:

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
  "createdAt": "TIMESTAMP",
  "retryCount": 0
}
```

3. Ve a Functions → Logs para ver la ejecución
4. Revisa la colección `expenses` para ver el gasto guardado

### Opción 2: Health Check

```bash
curl https://us-central1-[tu-proyecto].cloudfunctions.net/healthCheck
```

Debe responder:
```json
{
  "status": "ok",
  "timestamp": "2025-11-25T...",
  "service": "gastos-firebase-functions"
}
```

## 📱 Integrar con WhatsApp

Para recibir mensajes reales de WhatsApp, necesitas configurar un webhook de Twilio (Phase 1) que cree documentos en `whatsapp_queue`.

## 🔍 Ver Logs

```bash
npm run logs
```

## 📚 Siguientes Pasos

- **Configuración detallada:** Ver `SETUP.md`
- **Ejemplos de uso:** Ver `EXAMPLES.md`
- **Documentación completa:** Ver `README.md`

## ⚡ Comandos Útiles

```bash
# Desarrollo local con emuladores
npm run serve

# Build en modo watch
npm run build:watch

# Lint
npm run lint

# Ver configuración
firebase functions:config:get

# Ver logs en tiempo real
firebase functions:log
```

## 🆘 Troubleshooting Rápido

### Error: "API key not configured"

```bash
firebase functions:config:set anthropic.api_key="sk-ant-xxxxx"
npm run deploy
```

### Error: "Twilio credentials not configured"

```bash
firebase functions:config:set \
  twilio.account_sid="ACxxxxx" \
  twilio.auth_token="xxxxx"
npm run deploy
```

### Los mensajes no se procesan

1. Verifica logs: `npm run logs`
2. Revisa Firestore Console
3. Asegúrate de que `status: "pending"`

## 📊 Estructura del Proyecto

```
gastos-firebase-functions/
├── src/
│   ├── index.ts                    # 🎯 Main Cloud Function
│   ├── types/index.ts              # 📝 TypeScript types
│   ├── services/
│   │   ├── anthropic.service.ts    # 🤖 Anthropic Claude API
│   │   ├── expense.service.ts      # 💾 Firestore operations
│   │   └── twilio.service.ts       # 📱 WhatsApp messages
│   └── utils/
│       └── message-parser.ts       # 🔧 Message utilities
├── package.json
├── tsconfig.json
├── firebase.json
├── .firebaserc
├── README.md                       # 📖 Full documentation
├── SETUP.md                        # ⚙️ Detailed setup
├── EXAMPLES.md                     # 💡 Usage examples
└── QUICKSTART.md                   # 🚀 This file
```

## 🎯 Next Steps Checklist

- [ ] Desplegar funciones ✅
- [ ] Probar con documento de prueba ✅
- [ ] Configurar webhook de Twilio (Phase 1)
- [ ] Probar con WhatsApp real
- [ ] Configurar índices de Firestore
- [ ] Monitorear logs y métricas
- [ ] Crear reglas de seguridad de Firestore

## 💡 Tips

- Usa el sandbox de Twilio para pruebas gratuitas
- Monitorea el uso para no exceder el free tier
- Los logs son tu mejor amigo para debugging
- Prueba primero en local con emuladores

---

**Tiempo estimado total:** ~10 minutos

**¿Necesitas ayuda?** Revisa `SETUP.md` para instrucciones detalladas.
