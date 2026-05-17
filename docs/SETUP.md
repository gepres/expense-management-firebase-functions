# Guía de Configuración Detallada

Para el camino corto ver [`QUICKSTART.md`](QUICKSTART.md). Este documento cubre cada paso con detalle y troubleshooting.

## Requisitos Previos

- **Node.js 22** (runtime de las funciones; `engines.node` = 22)
- **JDK ≥ 21** (solo para el emulador de Firestore / `npm run smoke`)
- npm
- Firebase CLI: `npm install -g firebase-tools`
- Cuenta Firebase
- Cuenta Twilio con WhatsApp habilitado
- API Key de Anthropic Claude
- API Key de OpenAI (procesamiento de audio)
- `gcloud` autenticado (solo para aplicar la alert policy, ver §9.2)

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
3. Modelos por env (no-secretos, `src/config/models.ts`): `ANTHROPIC_MODEL_PRIMARY` (default `claude-sonnet-4-6`, texto+visión) y `ANTHROPIC_MODEL_HELPER` (default `claude-haiku-4-5`, fallbacks). Verifica que tu plan da acceso a esos modelos.

---

## Paso 4 — OpenAI (Whisper)

> Solo necesario si quieres procesar audios. Sin esta clave la función fallará al recibir notas de voz, pero texto e imágenes funcionan.

1. https://platform.openai.com/api-keys
2. Crea una API Key.
3. Modelo por env: `OPENAI_MODEL_TRANSCRIBE` (default `gpt-4o-mini-transcribe`, `language: "es"`), resuelto en `src/config/models.ts`.

---

## Paso 5 — Dependencias
```bash
npm install
```

---

## Paso 6 — Variables de entorno

Hay **dos clases** y NO se mezclan. Meter un secreto en `.env` rompe el deploy v2 (`"Secret environment variable overlaps non secret environment variable"`).

### 6.1 No-secretas → `.env` (versionado config, bundled al deploy)

`.env` contiene **solo** variables no sensibles. Se empaquetan en el deploy y Cloud Run las setea como env del runtime.

```env
# Requerida en prod: URL EXACTA configurada en Twilio (validación de firma).
TWILIO_WEBHOOK_URL=https://us-central1-<proyecto>.cloudfunctions.net/twilioWebhook

# Requerida: zona horaria. Cloud Run corre en UTC; sin esto "hoy/ayer/
# semana/mes" se calculan en UTC y tras las 19:00 Perú "hoy" salta de día
# y excluye los gastos del día peruano. Perú = UTC-5 fijo (sin DST).
TZ=America/Lima

# Opcional: deep-link al web app en los mensajes guiados (dead-end sin
# cuenta canónica + ingreso/transferir/movimientos retirados).
WEBAPP_URL=https://expense-app-gepres.web.app/cuentas

# Opcionales: modelos por tier (si se omiten, defaults de models.ts).
# ANTHROPIC_MODEL_PRIMARY=claude-sonnet-4-6
# ANTHROPIC_MODEL_HELPER=claude-haiku-4-5
# OPENAI_MODEL_TRANSCRIBE=gpt-4o-mini-transcribe
```

> `.env` está en `.gitignore` (no se versiona) pero **sí se bundlea al deploy** — un cambio acá requiere `npm run deploy` para tomar efecto. `TZ` también está reforzada en código (`src/utils/timezone.ts`, importado primero en `index.ts`).

### 6.2 Secretas → Secret Manager (NUNCA en `.env`)

Las 5 credenciales son **secrets v2** (`defineSecret` en `index.ts`, bindeados a las funciones). En runtime quedan como `process.env.<NAME>`.

```bash
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_WHATSAPP_NUMBER
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:secrets:set OPENAI_API_KEY

firebase functions:secrets:access ANTHROPIC_API_KEY   # verificar
```

`functions.config()` (v1) ya no se usa.

### 6.3 Emulador local → `.secret.local`

Con `defineSecret`, el emulador sondea Secret Manager y warnea `404` si los secrets no están. Override local: crear **`.secret.local`** en la raíz con las **5 claves** (formato `CLAVE=valor`). Está en `.gitignore`. Para `npm run smoke` los valores Twilio pueden ser dummy (el SID debe empezar con `AC`); el envío falla en silencio y el flujo igual cierra. Las no-secretas del `.env` (incl. `TZ`) el emulador las toma del `.env`.

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

Atajo sin UI — siembra usuario/cuenta/categorías y opcionalmente encola un mensaje:

```bash
npm run seed:emulator                          # solo siembra (phone +51999999999)
npm run seed:emulator -- --enqueue "50 almuerzo"
npm run seed:emulator -- --phone "+51987654321"   # siembra con TU número (E.164)
```

`--phone` (o env `SEED_PHONE`) sobrescribe el número del user sembrado y **debe ir antes** de `--enqueue`. Reiniciar el emulador borra Firestore en memoria → re-sembrar.

---

## Paso 8.1 — Probar con WhatsApp real en local (emulador + túnel)

Para un end-to-end real (mensaje desde tu WhatsApp → respuesta del bot) sin deploy: exponer el emulador con un túnel y apuntar el Sandbox de Twilio ahí.

1. **3 terminales:** (1) `npm run emulator`, (2) `ngrok http 127.0.0.1:5001` — usa `127.0.0.1`, no `localhost`, para evitar que ngrok resuelva a IPv6 donde el emulador no escucha —, (3) `npm run seed:emulator -- --phone "+51TUNUMERO"`.
2. **Verifica el túnel:** `GET https://<ngrok>/expense-app-gepres/us-central1/healthCheck` debe devolver `{"status":"ok",...}`.
3. **Twilio Sandbox** → *"When a message comes in"* = `https://<ngrok>/expense-app-gepres/us-central1/twilioWebhook`, método **POST**, Save. (ngrok Free cambia de URL en cada reinicio → reconfigurar.)
4. Únete al sandbox desde el WhatsApp de **ese mismo número** (`join <código>`) y envía `50 almuerzo`.

> **Firma de Twilio omitida en el emulador (bypass de auth gateado a local).** El emulador sirve la función bajo `/<project>/<region>/<fn>` y strip-ea ese prefijo: el código ve `req.url = "/"`, así que la URL reconstruida (`https://<host>/`) nunca coincide con la URL completa que Twilio firmó → `403 firma inválida` siempre en local. Por eso `validateTwilioRequest` (`src/utils/twilio-webhook.ts`) retorna `true` cuando `process.env.FUNCTIONS_EMULATOR === "true"`. Esa env var **solo** la setea el emulador de Firebase; en producción no existe, y ahí Cloud Run sirve la función en la raíz de su propia URL, así que la firma se valida normalmente. En los logs del emulador verás el warning `twilioWebhook: validación de firma OMITIDA (emulador)` — es esperado en local, **nunca** debe aparecer en producción.

---

## Paso 9 — Deploy
```bash
npm run deploy
# o
firebase deploy --only functions
```

El `predeploy` (`firebase.json`) corre **`lint` + `build` + `test`** como gate: si algo falla, aborta antes de subir. No hace falta `npm run build` aparte.

Salida esperada (**5 funciones**, runtime **Node.js 22 (2nd Gen)**):
```
functions[processWhatsAppQueue(us-central1)] Successful update operation.
functions[twilioWebhook(us-central1)] Successful update operation.
functions[exportExpenses(us-central1)] Successful update operation.
functions[healthCheck(us-central1)] Successful update operation.
functions[onWhatsAppQueueFailed(us-central1)] Successful update operation.
```

> El warning `package.json indicates an outdated version of firebase-functions` es **esperado**: estamos en `^6.6.0` a propósito (v7 es major no migrado). No bloquea.

## Paso 9.1 — Apuntar Twilio al webhook

En la consola de Twilio (Sandbox o número productivo de WhatsApp), configurar **"When a message comes in"** con la URL de `twilioWebhook` (método **POST**):

```
https://us-central1-<proyecto>.cloudfunctions.net/twilioWebhook
```

`twilioWebhook` valida `X-Twilio-Signature` con `TWILIO_AUTH_TOKEN` (rechaza `403` si no coincide) y encola en `whatsapp_queue`. Ya no hace falta el "Phase 1" externo.

> **Gotcha crítico (Cloud Run v2): hay que setear `TWILIO_WEBHOOK_URL`.** Twilio firma la URL **exacta** que tiene configurada. En Functions v2 (Cloud Run, alias `cloudfunctions.net/twilioWebhook`) el path se strip-ea: el código ve `req.url="/"`, reconstruye `https://host/` (sin `/twilioWebhook`) y la firma **nunca cuadra** → `403 firma inválida` (se ve en logs con la `url` reconstruida en la raíz). Fix: en `.env` setear `TWILIO_WEBHOOK_URL` = la URL **idéntica** a la puesta en Twilio, p. ej. `https://us-central1-<proyecto>.cloudfunctions.net/twilioWebhook`. `validateTwilioRequest` valida contra esa env si está; si no, cae a la reconstrucción (que en v2 falla). Tras setearla, redeploy: `firebase deploy --only functions:twilioWebhook`. En el **emulador** la validación se omite (ver §8.1).

---

## Paso 9.2 — Alerta de fallos (post-deploy, una vez)

`onWhatsAppQueueFailed` (función desplegada) emite un log estructurado estable cada vez que un mensaje agota los 3 reintentos (`whatsapp_queue → status: "failed"`). **El deploy NO crea la alerta** — es un recurso de Cloud Monitoring aparte.

Aplicar una vez con `gcloud` (autenticado, rol `roles/monitoring.editor`):

1. Crear/identificar un canal de notificación (email).
2. Editar `ops/alert-policy.json` → reemplazar `NOTIFICATION_CHANNEL_ID`.
3. `gcloud alpha monitoring policies create --project=expense-app-gepres --policy-from-file=ops/alert-policy.json`

Pasos exactos y filtro de la policy: **[`ops/README.md`](../ops/README.md)** (la policy está versionada en `ops/alert-policy.json`). Sin esto el bot funciona igual, pero un fallo del pipeline no notifica.

---

## Paso 10 — Índices de Firestore

> ⚠️ **Firestore rules/indexes NO se gestionan en este repo.** El proyecto Firebase `expense-app-gepres` es compartido con el web app `D:\PROYECTOS\gepres\gastos`, **dueño único** de `firestore.rules` y `firestore.indexes.json`. Este repo ya no tiene esos archivos ni bloque `firestore` en `firebase.json`. Los índices que el bot necesita **ya están fusionados** en `gastos/firestore.indexes.json`. Para deployarlos/cambiarlos: `cd D:\PROYECTOS\gepres\gastos && firebase deploy --only firestore`. (Razón: deployar las rules deny-all de este repo machacó las del web app y rompió el login — ver §11.)

Índices que requiere el bot (ya presentes en el archivo canónico de `gastos`):

| Colección       | Campos                                      | Usado por                  |
|-----------------|---------------------------------------------|----------------------------|
| `learning_log`  | `type` ASC, `tokens` ARRAY                  | `queryRelevant`            |
| `expenses`      | `userId` ASC, `createdAt` DESC              | `getExpensesByUserId`, `getLastExpense` |
| `expenses`      | `userId` ASC, `fecha` DESC                  | `getExpensesBetween`/`getSummaryBetween`/`getExpenseSummary` (consultas y por mes) |
| `expenses`      | `userId` ASC, `needsClassification` ASC     | `getPending`               |
| `expenses`      | `userId` ASC, `needsReview` ASC             | `getPending`               |
| `expenses`      | `userId` ASC, `amountFlagged` ASC           | `getPending` (monto atípico) |

> Los índices de `movements`/`accountId` ya **no** los usa el bot (decisión "Opción A": el bot dejó de gestionar el ledger; ver `docs/ROADMAP.md` addendum). `expenses userId+fecha DESC` ya está en el archivo canónico de `gastos` — verificado. Sin estos índices, `pendientes`/consultas/resumen por mes fallan en runtime con un enlace directo para crearlos.

## Paso 10.1 — Migración de cuentas

> ⚠️ **Obsoleto (Opción A).** `npm run backfill:accounts` creaba la cuenta legacy `users/{uid}/accounts` y un ledger propio del bot. Tras el desacople el bot usa la colección **canónica top-level `accounts`** (dueño: web app) y ya no gestiona saldo/ledger. Este backfill **no es necesario** para nuevas instalaciones; el usuario debe tener una cuenta canónica creada desde el web app (si no, el bot responde con un mensaje guiado a `WEBAPP_URL`). Se conserva el script por compatibilidad histórica.

---

## Paso 11 — Reglas de Firestore (las gestiona el proyecto `gastos`)

Las `firestore.rules` de producción son las del web app: `D:\PROYECTOS\gepres\gastos\firestore.rules` (auth-based: cada usuario lee lo suyo, accounts, transfers, shared_groups, etc.; `whatsapp_queue` → `if false`). El bot usa **Admin SDK**, que **salta** las security rules, así que esas reglas no lo afectan.

**No deployar reglas desde este repo** (ya no tiene `firestore.rules`). Cambios de reglas → editar y deployar desde `D:\PROYECTOS\gepres\gastos`. Un deploy de las reglas restrictivas de este repo rompería el acceso de cliente del web app (incidente real 2026-05-15).

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
firebase functions:secrets:access ANTHROPIC_API_KEY   # ver un secret
firebase functions:list                                # 5 funciones
npm run logs                                            # tail prod
npm run smoke                                           # E2E emulador
npm run lint
npm run build:watch
```

> `firebase functions:config:*` era v1 — **no aplica** (este repo usa `defineSecret` + `.env`).

---

## Troubleshooting

### `Anthropic API key not configured`
```bash
firebase functions:secrets:set ANTHROPIC_API_KEY
npm run deploy
```

### `Twilio credentials not configured`
```bash
firebase functions:secrets:set TWILIO_ACCOUNT_SID
firebase functions:secrets:set TWILIO_AUTH_TOKEN
firebase functions:secrets:set TWILIO_WHATSAPP_NUMBER
npm run deploy
```

### `OpenAI API key not configured`
Solo afecta a audios. Idéntico al patrón anterior con `firebase functions:secrets:set OPENAI_API_KEY`.

### Función no se dispara
1. `npm run logs` y filtrar por `processWhatsAppQueue`.
2. Verifica que el doc en `whatsapp_queue` tenga `status: "pending"` al crearse.
3. Confirma que el trigger está activo en Firebase Console → Functions.

### `The query requires an index`
Firebase Functions devuelve el link directo en el error. Click → crear → esperar build (1–5 min).

### Usuario no encontrado
- Verifica que `users/{uid}.whatsappPhone` coincida con el número entrante normalizado (`+51XXXXXXXXX`, sin `whatsapp:`).
- El método de búsqueda está en `user.service.ts:findByWhatsAppPhone`.

### `cuánto gasté hoy` / `gastos de hoy` vuelve vacío aunque hay gastos
Zona horaria. Confirma que `TZ=America/Lima` está en `.env` y que se desplegó (`firebase deploy` loguea `Loaded environment variables from .env`). Sin `TZ`, Cloud Run calcula "hoy" en UTC y tras las 19:00 Perú devuelve el día siguiente. Verificable: `TZ=UTC node -e "..."` vs `TZ=America/Lima` sobre `resolveQueryPeriod('hoy')`. Requiere **redeploy** para tomar efecto (la `.env` se bundlea al deploy).

### Usuario sin cuenta / `ingreso`/`transferir` "deriva a la app"
Esperado tras "Opción A": el bot no gestiona saldo/ledger. El usuario crea su cuenta en el web app (`WEBAPP_URL` → `/cuentas`); `ingreso`/`transferir`/`movimientos` se hacen en la app. `saldo`/`saldos` son lectura de la cuenta canónica.

### No llega alerta cuando un mensaje falla
La función `onWhatsAppQueueFailed` emite el log, pero la **alert policy** no se crea con el deploy: aplicar `ops/README.md` (§9.2).

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
