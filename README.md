# Gastos Firebase Functions

Sistema de seguimiento de gastos a través de WhatsApp usando Firebase Functions, Twilio y Anthropic Claude.

## Arquitectura

```
Usuario → WhatsApp → Twilio → Firestore Queue → Cloud Function → Anthropic → Firestore (gastos) → Respuesta WhatsApp
```

## Estructura del Proyecto

```
gastos-firebase-functions/
├── src/
│   ├── index.ts                    # Cloud Function principal
│   ├── types/
│   │   └── index.ts                # Definiciones de TypeScript
│   ├── services/
│   │   ├── anthropic.service.ts    # Integración con Anthropic Claude
│   │   ├── expense.service.ts      # Lógica de gastos en Firestore
│   │   └── twilio.service.ts       # Envío de mensajes WhatsApp
│   └── utils/
│       └── message-parser.ts       # Utilidades de parseo
├── package.json
├── tsconfig.json
└── .eslintrc.js
```

## Configuración

### 1. Instalar Dependencias

```bash
npm install
```

### 2. Configurar Variables de Entorno

#### Para Producción (Firebase Functions Config):

```bash
firebase functions:config:set \
  twilio.account_sid="ACxxxxx" \
  twilio.auth_token="xxxxx" \
  twilio.whatsapp_number="whatsapp:+14155238886" \
  anthropic.api_key="sk-ant-xxxxx"
```

#### Para Desarrollo Local (.env):

Copia `.env.example` a `.env` y completa los valores:

```bash
cp .env.example .env
```

### 3. Compilar TypeScript

```bash
npm run build
```

### 4. Ejecutar Localmente (Emuladores)

```bash
npm run serve
```

### 5. Desplegar a Firebase

```bash
npm run deploy
```

## Cloud Functions

### `processWhatsAppQueue`

**Trigger:** Firestore onCreate en `whatsapp_queue/{queueId}`

**Proceso:**
1. Recibe mensaje de WhatsApp desde la cola de Firestore
2. Parsea el mensaje usando Anthropic Claude
3. Extrae información del gasto (monto, categoría, descripción)
4. Guarda el gasto en Firestore
5. Envía confirmación por WhatsApp

### `healthCheck`

**Trigger:** HTTPS Request

**URL:** `https://[region]-[project-id].cloudfunctions.net/healthCheck`

**Respuesta:** JSON con estado del servicio

## Firestore Collections

### `whatsapp_queue`

Cola de mensajes entrantes de WhatsApp.

```typescript
{
  phoneNumber: string;
  message: string;
  webhookBody: TwilioWebhookBody;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Timestamp;
  processedAt?: Timestamp;
  error?: string;
  retryCount: number;
}
```

### `expenses`

Gastos registrados por los usuarios.

```typescript
{
  phoneNumber: string;
  amount: number;
  category: string;
  description: string;
  date: string;           // YYYY-MM-DD
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

## Uso

### Registrar Gastos

Envía un mensaje de WhatsApp como:
- "Gasté 25 soles en almuerzo"
- "50 en taxi"
- "Compré medicina por 80"

### Comandos Disponibles

- `resumen` / `summary` / `total` - Ver resumen de gastos
- `ayuda` / `help` - Mostrar ayuda

## Desarrollo

### Lint

```bash
npm run lint
```

### Build Watch Mode

```bash
npm run build:watch
```

### Ver Logs

```bash
npm run logs
```

## Seguridad

- Sanitización de inputs
- Validación de webhooks de Twilio
- Rate limiting automático de Firebase Functions
- Manejo seguro de credenciales

## Manejo de Errores

- Sistema de reintentos automático (máximo 3 intentos)
- Logging detallado en Firebase Functions
- Mensajes de error claros enviados por WhatsApp

## Testing

Para probar localmente:

1. Inicia los emuladores:
```bash
npm run serve
```

2. Crea un documento en la colección `whatsapp_queue`:
```javascript
{
  phoneNumber: "+51999999999",
  message: "Gasté 50 soles en almuerzo",
  webhookBody: {
    MessageSid: "test-sid",
    From: "whatsapp:+51999999999",
    Body: "Gasté 50 soles en almuerzo"
  },
  status: "pending",
  createdAt: Firestore.Timestamp.now(),
  retryCount: 0
}
```

3. La función se ejecutará automáticamente.

## Límites y Consideraciones

- **Anthropic API:** Límite de rate según tu plan
- **Twilio:** Costos por mensaje de WhatsApp
- **Firebase Functions:** Free tier: 2M invocaciones/mes
- **Firestore:** Free tier: 50K lecturas, 20K escrituras/día

## Próximos Pasos

- [ ] Implementar autenticación de usuarios
- [ ] Agregar reportes mensuales
- [ ] Soporte para múltiples monedas
- [ ] Dashboard web para visualizar gastos
- [ ] Exportación de gastos a Excel/CSV
- [ ] Notificaciones de presupuesto

## Licencia

MIT
