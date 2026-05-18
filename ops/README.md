# Ops — alerta de fallos del pipeline

El pipeline emite **dos** logs estructurados estables (la alert policy los
cubre con `combiner: OR`):

- `whatsapp_queue_failed` — `onWhatsAppQueueFailed` lo emite cuando un doc de
  `whatsapp_queue` transiciona a `status: "failed"` (3 reintentos agotados).
- `whatsapp_queue_stuck` — `reprocessPendingQueue` (scheduler, cada 2 min) lo
  emite cuando un doc `pending` con `retryCount > 3` no progresa. Ese mismo
  scheduler **resucita el reintento** (reprocesa `pending`, recupera
  `processing` huérfano); sin él un fallo transitorio se perdía en silencio.

Este runbook crea la **alert policy** que notifica sobre esos logs.

> El deploy de funciones **no** crea la alerta — es un recurso de Cloud
> Monitoring aparte. Hacer esto una vez (idempotente: re-correr actualiza).

Requisitos: `gcloud` autenticado con permisos de Monitoring en el proyecto
`expense-app-gepres` (rol `roles/monitoring.editor`).

## 1. Canal de notificación (email)

Crear (o reusar) un canal de email. Reemplazá el correo:

```bash
gcloud beta monitoring channels create \
  --project=expense-app-gepres \
  --display-name="Ops gastos-bot" \
  --type=email \
  --channel-labels=email_address=TU_CORREO@ejemplo.com
```

Copiá el `name` que devuelve, p.ej.
`projects/expense-app-gepres/notificationChannels/1234567890`.
Listar los existentes:

```bash
gcloud beta monitoring channels list --project=expense-app-gepres \
  --format="table(name,displayName,labels.email_address)"
```

## 2. Crear la alert policy

Editá `ops/alert-policy.json` y reemplazá `NOTIFICATION_CHANNEL_ID` por el
ID numérico del canal del paso 1. Luego:

```bash
gcloud alpha monitoring policies create \
  --project=expense-app-gepres \
  --policy-from-file=ops/alert-policy.json
```

Verificar:

```bash
gcloud alpha monitoring policies list --project=expense-app-gepres \
  --filter='displayName="WhatsApp queue failed"' \
  --format="table(name,enabled,conditions[0].displayName)"
```

## 3. Probar (opcional)

Forzar un `failed` en el emulador o esperar uno real. El log debe matchear
alguno de los dos filtros (la policy usa `combiner: OR`):

```
resource.type="cloud_run_revision"
jsonPayload.event="whatsapp_queue_failed"
severity=ERROR
```
```
resource.type="cloud_run_revision"
jsonPayload.event="whatsapp_queue_stuck"
severity=ERROR
```

(Mismo filtro que la condición de la policy — ver
`alert-policy.json` y `CLAUDE.md` §3 "Observabilidad".)

## Alternativa por consola

Cloud Monitoring → Alerting → Create policy → Condition type **Log match** →
pegar el filtro de arriba → notification channel → Save.

## Notas

- `notificationRateLimit: 300s` evita tormenta de alertas si fallan muchos
  mensajes seguidos; `autoClose: 1800s` cierra el incidente solo.
- Funciones v2 corren en Cloud Run → `resource.type="cloud_run_revision"`.
- Si se renombra alguno de los eventos (`whatsapp_queue_failed` en
  `onWhatsAppQueueFailed`, `whatsapp_queue_stuck` en `reprocessPendingQueue`),
  actualizar el filtro acá **y** en `alert-policy.json` (mantener en sync).
