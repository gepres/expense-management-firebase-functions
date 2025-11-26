# 📊 Project Summary - Gastos Firebase Functions

## 🎯 Objetivo del Proyecto

Sistema automatizado de seguimiento de gastos personales a través de WhatsApp, usando:
- **Firebase Functions** para procesamiento backend
- **Anthropic Claude** para interpretación de lenguaje natural
- **Twilio** para comunicación por WhatsApp
- **Firestore** para almacenamiento de datos

## 🏗️ Arquitectura

```
┌─────────────┐
│   Usuario   │
│  WhatsApp   │
└──────┬──────┘
       │
       │ Mensaje: "Gasté 50 en almuerzo"
       ▼
┌─────────────┐
│   Twilio    │
│  (Webhook)  │
└──────┬──────┘
       │
       │ POST webhook → Backend (Phase 1)
       ▼
┌─────────────────────┐
│    Firestore        │
│  whatsapp_queue     │◄──── onCreate trigger
│  (status: pending)  │
└─────────────────────┘
       │
       │ Cloud Function trigger
       ▼
┌─────────────────────────────┐
│  processWhatsAppQueue()     │
│  Firebase Function          │
│                             │
│  1. Lee mensaje de cola     │
│  2. Llama Anthropic API     │
│  3. Parsea gasto            │
│  4. Guarda en Firestore     │
│  5. Envía confirmación      │
└──────────┬──────────────────┘
           │
           ├──────────────┐
           │              │
           ▼              ▼
    ┌────────────┐  ┌─────────┐
    │ Anthropic  │  │ Twilio  │
    │   Claude   │  │ Send    │
    │  (Parse)   │  │  SMS    │
    └────────────┘  └─────────┘
           │              │
           │              ▼
           │        ┌─────────────┐
           │        │   Usuario   │
           │        │ (Respuesta) │
           │        └─────────────┘
           ▼
    ┌─────────────┐
    │  Firestore  │
    │  expenses   │
    │  (guardado) │
    └─────────────┘
```

## 📁 Estructura de Archivos

```
gastos-firebase-functions/
│
├── 📄 Configuration Files
│   ├── package.json              # Dependencies & scripts
│   ├── tsconfig.json             # TypeScript config
│   ├── firebase.json             # Firebase deploy config
│   ├── .firebaserc               # Firebase project config
│   ├── .eslintrc.js              # ESLint rules
│   ├── .gitignore                # Git ignore patterns
│   ├── .env.example              # Environment template
│   └── firestore.rules           # Firestore security rules
│
├── 📚 Documentation
│   ├── README.md                 # Main documentation
│   ├── QUICKSTART.md             # 10-minute setup
│   ├── SETUP.md                  # Detailed setup guide
│   ├── EXAMPLES.md               # Usage examples
│   └── PROJECT_SUMMARY.md        # This file
│
└── 📂 src/
    ├── index.ts                  # 🎯 Main Cloud Function
    │
    ├── 📂 types/
    │   └── index.ts              # TypeScript interfaces
    │
    ├── 📂 services/
    │   ├── anthropic.service.ts  # 🤖 AI message parsing
    │   ├── expense.service.ts    # 💾 Firestore operations
    │   └── twilio.service.ts     # 📱 WhatsApp messaging
    │
    └── 📂 utils/
        └── message-parser.ts     # 🔧 Text utilities
```

## 🔑 Componentes Principales

### 1. Cloud Functions

| Function | Type | Trigger | Purpose |
|----------|------|---------|---------|
| `processWhatsAppQueue` | Background | Firestore onCreate | Procesar mensajes de WhatsApp |
| `healthCheck` | HTTPS | HTTP Request | Verificar estado del servicio |

### 2. Services

| Service | Responsibility | External API |
|---------|---------------|--------------|
| `AnthropicService` | Interpretar mensajes de texto | Anthropic Claude API |
| `ExpenseService` | CRUD de gastos | Firestore |
| `TwilioService` | Enviar mensajes WhatsApp | Twilio API |

### 3. Firestore Collections

| Collection | Purpose | Documents |
|------------|---------|-----------|
| `whatsapp_queue` | Cola de mensajes entrantes | ~100-1K/día |
| `expenses` | Gastos registrados | ~50-500/usuario/mes |

## 📊 Data Flow

### Proceso de Registro de Gasto

```
1. Usuario envía mensaje: "Gasté 50 en almuerzo"
   ↓
2. Twilio recibe mensaje y envía webhook
   ↓
3. Backend (Phase 1) crea documento en whatsapp_queue
   {
     phoneNumber: "+51999999999",
     message: "Gasté 50 en almuerzo",
     status: "pending"
   }
   ↓
4. Cloud Function detecta nuevo documento (trigger)
   ↓
5. Actualiza status a "processing"
   ↓
6. Envía mensaje a Anthropic Claude:
   "Analiza: Gasté 50 en almuerzo"
   ↓
7. Anthropic responde:
   {
     amount: 50,
     category: "comida",
     description: "almuerzo",
     date: "2025-11-25"
   }
   ↓
8. Guarda gasto en Firestore collection "expenses"
   ↓
9. Envía confirmación por WhatsApp vía Twilio
   ↓
10. Actualiza status a "completed"
```

## 🔐 Security & Configuration

### Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `TWILIO_ACCOUNT_SID` | Twilio Dashboard | Autenticación Twilio |
| `TWILIO_AUTH_TOKEN` | Twilio Dashboard | Autenticación Twilio |
| `TWILIO_WHATSAPP_NUMBER` | Twilio Sandbox | Número de envío |
| `ANTHROPIC_API_KEY` | Anthropic Console | Autenticación Claude |

### Firestore Security

- ✅ Solo Cloud Functions pueden escribir en `whatsapp_queue`
- ✅ Solo Cloud Functions pueden escribir en `expenses`
- ✅ Los usuarios no tienen acceso directo a las colecciones
- 🔄 Futuro: Permitir lectura de propios gastos con auth

## 📈 Scalability & Performance

### Current Capacity

| Metric | Free Tier | Estimated Load |
|--------|-----------|----------------|
| Function Invocations | 2M/month | ~3K-30K/month |
| Firestore Reads | 50K/day | ~500-5K/day |
| Firestore Writes | 20K/day | ~300-3K/day |
| Anthropic API | Varies | ~1K-10K/month |
| Twilio Messages | Sandbox only | ~1K-10K/month |

### Performance Metrics

- ⚡ **Function Cold Start:** ~3-5 seconds
- ⚡ **Function Warm:** ~500ms-1s
- ⚡ **Anthropic API:** ~2-4 seconds
- ⚡ **Twilio Send:** ~1-2 seconds
- ⚡ **Total Time:** ~5-10 seconds per message

## 🚀 Deployment Checklist

### Initial Setup
- [x] Create Firebase project
- [x] Install dependencies
- [x] Configure environment variables
- [x] Build TypeScript
- [x] Deploy functions

### Configuration
- [ ] Update `.firebaserc` with project ID
- [ ] Set Firebase Functions config
- [ ] Configure Twilio webhook (Phase 1)
- [ ] Test with sandbox WhatsApp
- [ ] Deploy Firestore rules

### Testing
- [ ] Test health check endpoint
- [ ] Create test document in queue
- [ ] Verify expense creation
- [ ] Test WhatsApp message receipt
- [ ] Monitor logs

### Production
- [ ] Set up monitoring alerts
- [ ] Configure budget alerts
- [ ] Document API keys securely
- [ ] Set up backup strategy
- [ ] Plan scaling strategy

## 📊 Monitoring & Observability

### Key Metrics to Monitor

1. **Function Execution**
   - Invocation count
   - Execution time
   - Error rate
   - Retry count

2. **Firestore**
   - Read/Write operations
   - Document count growth
   - Query performance
   - Storage usage

3. **External APIs**
   - Anthropic API calls
   - Twilio message sends
   - API error rates
   - Response times

### Log Levels

```typescript
functions.logger.info()    // Normal operation
functions.logger.warn()    // Warnings (parsing failures)
functions.logger.error()   // Errors (API failures)
```

## 🔄 Error Handling

### Retry Strategy

```
Attempt 1 (retryCount: 0) → Fail
  ↓ status: "pending", retryCount: 1
Attempt 2 (retryCount: 1) → Fail
  ↓ status: "pending", retryCount: 2
Attempt 3 (retryCount: 2) → Fail
  ↓ status: "pending", retryCount: 3
Final Fail (retryCount: 3)
  ↓ status: "failed"
```

### Error Types

| Error | Status | Action |
|-------|--------|--------|
| Anthropic API failure | Retry | Max 3 attempts |
| Twilio send failure | Complete | Log error, continue |
| Firestore write failure | Retry | Max 3 attempts |
| Invalid message format | Complete | Send error to user |

## 🎯 Use Cases

### Primary Use Case: Expense Tracking

**Input:** Natural language message
**Output:** Structured expense + Confirmation

**Examples:**
- "Gasté 50 en almuerzo" → S/ 50.00, comida
- "30 soles de taxi" → S/ 30.00, transporte
- "Compré medicina por 120" → S/ 120.00, salud

### Secondary Use Case: Reports

**Input:** Command message
**Output:** Summary report

**Commands:**
- `resumen` → Total + Category breakdown
- `ayuda` → Help message

## 🔮 Future Enhancements

### Phase 3: User Dashboard
- [ ] Web interface para visualizar gastos
- [ ] Gráficos y reportes
- [ ] Exportación a Excel/CSV

### Phase 4: Advanced Features
- [ ] Presupuestos mensuales
- [ ] Alertas de gastos excesivos
- [ ] Categorización personalizable
- [ ] Múltiples usuarios/familias
- [ ] Soporte para múltiples monedas

### Phase 5: Analytics
- [ ] Machine learning para predecir gastos
- [ ] Recomendaciones de ahorro
- [ ] Análisis de patrones de consumo

## 💰 Cost Estimation

### Monthly Costs (Estimate for 1000 messages/month)

| Service | Usage | Cost |
|---------|-------|------|
| Firebase Functions | 1K invocations | **FREE** (under 2M limit) |
| Firestore | ~6K reads, ~3K writes | **FREE** (under limits) |
| Anthropic API | 1K requests | ~$0.50-2.00 |
| Twilio WhatsApp | 1K messages | ~$5.00-10.00 |
| **TOTAL** | | **~$5.50-12.00/month** |

### Scaling to 10K messages/month

| Service | Usage | Cost |
|---------|-------|------|
| Firebase Functions | 10K invocations | **FREE** |
| Firestore | ~60K reads, ~30K writes | ~$0.50-1.00 |
| Anthropic API | 10K requests | ~$5.00-20.00 |
| Twilio WhatsApp | 10K messages | ~$50.00-100.00 |
| **TOTAL** | | **~$55.50-121.00/month** |

## 🎓 Learning Resources

### Firebase
- [Firebase Functions Docs](https://firebase.google.com/docs/functions)
- [Firestore Triggers](https://firebase.google.com/docs/functions/firestore-events)

### Anthropic Claude
- [Anthropic API Docs](https://docs.anthropic.com/)
- [Claude SDK](https://github.com/anthropics/anthropic-sdk-typescript)

### Twilio
- [Twilio WhatsApp Docs](https://www.twilio.com/docs/whatsapp)
- [WhatsApp Sandbox](https://www.twilio.com/docs/whatsapp/sandbox)

## 📞 Support

### Troubleshooting
1. Check logs: `npm run logs`
2. Verify config: `firebase functions:config:get`
3. Test locally: `npm run serve`
4. Review Firestore documents

### Common Issues
- **API key errors:** Re-set config and redeploy
- **No WhatsApp response:** Check Twilio logs
- **Parse failures:** Check Anthropic API limits
- **Trigger not firing:** Verify Firestore rules

---

**Project Status:** ✅ Ready for deployment
**Version:** 1.0.0
**Last Updated:** 2025-11-25
