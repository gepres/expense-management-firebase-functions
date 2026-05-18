# Auditoría — Pipeline IA de gastos por WhatsApp

- **Fecha:** 2026-05-18
- **Alcance:** flujo de validación (texto/imagen/voz), uso y tipo de "agente" IA,
  escalabilidad multiusuario, topes y bloqueantes.
- **Repos analizados:** `gastos-firebase-functions` (orquestación) +
  `@gastos/expense-ai` `0.3.0` (lógica pura compartida).
- **Método:** lectura directa de código (no documentación). Referencias como
  `archivo:línea`.
- **Costos:** ver documento separado [`COST_SCALING.md`](COST_SCALING.md).

---

## Resumen ejecutivo

| Dimensión | Veredicto |
|---|---|
| Arquitectura de "agente" | **No es un agente autónomo.** Pipeline determinista con llamadas LLM stateless de un solo turno + clasificador por reglas + memoria por usuario (RAG-lite). |
| Validación texto/imagen/voz | Sólida y estratificada; pero monto/fecha/dedupe se validan **después** de gastar tokens IA. |
| Escalabilidad multiusuario | Buen desacople por cola, **pero con bloqueante crítico de confiabilidad** y techos no gestionados. |
| Bloqueante #1 (P0) | **El mecanismo de reintentos está muerto:** nada reprocesa `status:"pending"` → error transitorio = mensaje perdido en silencio, sin alerta. |

---

## Estado de remediación (2026-05-18)

Recomendaciones #1–#6 (P0→P2) implementadas (build + lint + 36 tests en
verde; **no** desplegado aún):

| Rec. | Estado | Qué se hizo |
|---|---|---|
| #1 reintento (P0) | ✅ Hecho | `handleQueueDoc` extraído; `reprocessPendingQueue` (`onSchedule` cada 2 min) reprocesa `pending`, recupera `processing` huérfano y hace claim transaccional. |
| #2 resiliencia IA (P0/P1) | ✅ Hecho | `src/utils/retry.ts` (`withRetry`/`isTransientError`, backoff+jitter) en Anthropic/OpenAI; transitorio se propaga → `pending` (no se traga). |
| #3 dedupe sin carrera (P1) | ✅ Hecho | `twilioWebhook` encola con id determinístico `= MessageSid` (`.doc(sid).create()` + `ALREADY_EXISTS` idempotente). |
| #6 alerta `pending` atascado (P1/P2) | ✅ Hecho | Evento `whatsapp_queue_stuck` + 2ª condición en `ops/alert-policy.json` (combiner OR). |
| #4 `softDeleteAll` por chunks (P1) | ✅ Hecho | `softDeleteAll` paginado + BulkWriter (≤500 auto); nuevo `purgeSoftDeleted` + job `purgeDeletedLearningLog` (`onSchedule` diario, retención `LEARNING_LOG_PURGE_DAYS`=30). |
| #5 config explícita / caché / singletons (P2) | ✅ Hecho | `setGlobalOptions` (region/memory/timeout/maxInstances) + override del webhook; `TtlCache` in-instance para categorías/métodos; clientes SDK Twilio/Anthropic/OpenAI como singletons lazy por instancia. |

> Despliegue: requiere `firebase deploy --only functions`. Da de alta dos
> jobs de Cloud Scheduler (`reprocessPendingQueue`, `purgeDeletedLearningLog`)
> y aplica la config explícita (`region` = us-central1, MISMA actual → no
> recrea funciones). Pendiente de aprobación del usuario (este repo solo
> despliega cuando se pide). Tras desplegar, el evento `whatsapp_queue_stuck`
> necesita re-aplicar la alert policy (`ops/README.md`).

---

## 1. Flujo de validación por canal

Entrada única: `twilioWebhook` (`onRequest`, `index.ts:1588`) valida
`X-Twilio-Signature` y encola en `whatsapp_queue` con `.add()`;
`processWhatsAppQueue` (`onDocumentCreated`, `index.ts:68`) procesa.
Todo gasto converge en `finalizeAndRegisterExpense` (`index.ts:694`).

**Validaciones previas comunes (`index.ts:93-202`):**
usuario registrado (`UserService.findByWhatsAppPhone`) → onboarding idempotente
(`OnboardingService.tryClaimFirstContact`) → cuenta canónica
(`NoCanonicalAccountError` = dead-end guiado, sin retry) → ruteo por media.

### 1.1 Texto — `processTextMessage` (`index.ts:497`)

Orden de corte (todo determinista, **sin IA**):

1. Confirmación pendiente sí/no (`PendingActionService`) — se evalúa **primero**.
2. Comando de cuenta → comando bot → ayuda → consulta de lectura → edición →
   comando legacy.
3. **Regex de gasto** (`MessageParser.parseExpenseFromText`). Acierta → `finalize`
   sin IA.
4. Solo si falla todo: `aiQuotaBlocked` → **Anthropic** `parseExpenseMessage`
   (tier `primary` / Sonnet).

### 1.2 Imagen — `processImageMessage` (`index.ts:268`)

`aiQuotaBlocked` → "⏳ Procesando" → `downloadTwilioMedia`
(axios, timeout 30 s, base64 en memoria) → valida MIME → **Anthropic Vision**
`extractReceiptData` (Sonnet) → `parseReceipt` (tolerante a fences/JSON) →
`finalize`. JSON inválido o `{error}` → mensaje de error + `completed`
(no reintenta).

### 1.3 Voz — `processAudioMessage` (`index.ts:380`)

`aiQuotaBlocked` → "🎤 Procesando" → download → valida MIME → **OpenAI**
`gpt-4o-mini-transcribe` (tmpfile, limpiado en `finally`) → confirma
transcripción → **Anthropic** `parseExpenseMessage` (Sonnet) →
`finalize`. **Dos proveedores IA en serie por nota de voz.**

### 1.4 Validación contra taxonomía — `finalize` + `@gastos/expense-ai`

`classifyExpense` (`classify.ts:362`) — ranking estricto 1→6:

1–3. Taxonomía del usuario (`suggestions_ideas` → subcat → cat) por
**palabra completa** (`phraseMatches`, nunca substring).
4. Historial `learning_log` por solape de tokens (`tokenOverlap ≥ 0.5`,
prioriza correcciones).
5a. Reusar hint libre del LLM (costo 0) · 5b. **LLM acotado a la taxonomía**
(helper/Haiku) solo en miss.
6. `sin_clasificar` (`needsClassification`).

Dentro de `finalize` además: `resolvePaymentMethod` (puro); si ambiguo +
hint → `disambiguatePaymentMethod` (helper LLM); fecha con pista temporal
sin regex → `parseRelativeDate` (helper LLM); monto atípico vs mediana de
50 gastos → flag (no bloquea).

---

## 2. Uso de IA y tipo de "agente"

**No es un agente autónomo.** Mapeo a la taxonomía estándar:

| Patrón | ¿Aplica? | Evidencia |
|---|---|---|
| Agente Simple (LLM stateless) | ✅ **Es esto a nivel de cada llamada** | 1 prompt → 1 JSON. `thinking:disabled`, `effort:low`, `max_tokens` 128–1024, sin historial conversacional en el contexto del modelo (`models.ts:54`). |
| Agente con Memoria | ⚠️ **Solo en sentido débil** | `learning_log` es RAG-lite externo que **alimenta un ranker por reglas**, no el contexto del modelo. El LLM clasificador solo recibe nombres de categorías candidatas (`classify.ts:393-408`). |
| Agente con Herramientas / tool-use | ❌ | Sin `tools`/function-calling. Las "herramientas" las invoca código determinista. |
| ReAct / Planner / Autónomo | ❌ | Sin loop de razonamiento, auto-corrección ni planificación. |
| Multi-agente / Orquestador LLM | ❌ | El "orquestador" es `classifyExpense`, función pura con orden fijo. |

**Caracterización precisa:** *workflow determinista "regex/reglas primero,
LLM como fallback acotado"* con **5 especialistas LLM stateless** (Vision OCR,
parser texto/voz, parser fecha, clasificador taxonomía, desambiguador método)
invocados por código, **memoria por usuario de recuperación** (token-overlap)
que sesga reglas, y **máquina de estados de conversación corta**
(`pending_action` / sesión wsp, TTL) para confirmaciones sí/no.

**Recomendación de diseño:** es el patrón correcto para este caso —
**no** migrar a agente con tools (más costo, latencia y no-determinismo,
sin beneficio).

---

## 3. Escalabilidad multiusuario

### Fortalezas

- Desacople por cola: el webhook responde 200 rápido; procesamiento async →
  escala horizontal natural y absorbe ráfagas.
- Aislamiento por usuario en Firestore; queries indexadas por `userId`.
- Cuota IA por usuario (`quota.service.ts`) + tracking de consumo
  (`usage.service.ts`).
- Idempotencia por `MessageSid` (parcial — ver §4 P1).
- Lógica IA pesada centralizada en paquete puro testeable.

### Modelo de throughput (el techo real)

`processWhatsAppQueue` es trigger de evento Firestore → en Cloud Functions v2
la **concurrencia es fija = 1 por instancia** (no configurable para event
triggers). Cada instancia procesa **un mensaje a la vez** durante todo el
pipeline secuencial:

| Canal | Latencia pipeline | Throughput / instancia |
|---|---|---|
| Texto regex (sin IA) | ~0.5–1.5 s | ~1–2 msg/s |
| Texto fallback LLM | ~3–6 s | ~0.2–0.3 msg/s |
| Imagen (Vision) | ~5–10 s | ~0.1–0.2 msg/s |
| Voz (Whisper + Sonnet) | ~6–12 s | ~0.1 msg/s |

El escalado depende 100% del autoscaling de Cloud Run (N instancias =
N mensajes simultáneos). En el diagnóstico original no había
`maxInstances`/`memory`/`timeoutSeconds`/`region`/`setGlobalOptions` (todo
en defaults sin gestionar).

> **Actualización (remediado, §5 #5):** ahora `setGlobalOptions` fija
> `region: us-central1` (la misma implícita), `memory: 512MiB`,
> `timeoutSeconds: 120`, `maxInstances: 20`, con overrides por función.
> `minInstances` se dejó en 0 a propósito (cold start aceptado, §4 P3).

---

## 4. Observaciones / hallazgos por severidad

> Hallazgos del diagnóstico original (2026-05-18) **anotados con su estado
> tras la remediación**. Marcadores: ✅ resuelto · ⚠️ parcial · ⛔ abierto
> (aceptado). Detalle de la solución en "Estado de remediación" y §5.

### 🔴 P0 — El reintento estaba muerto (pérdida silenciosa) — ✅ RESUELTO

Diagnóstico: el `catch` dejaba `pending` + `retryCount++` pero **nada**
reprocesaba (`onDocumentCreated` solo dispara en creación; sin `onSchedule`/
`retry:true`) → doc atascado para siempre; `failed` y la alerta
inalcanzables. La máquina `retryCount/pending` era código muerto.

**Resuelto (#1):** `handleQueueDoc` extraído; `reprocessPendingQueue`
(`onSchedule` 2 min) reprocesa `pending` con claim transaccional
`pending→processing`, recupera `processing` huérfano (>10 min) y emite
`whatsapp_queue_stuck`.

### 🔴 P0/P1 — Sin manejo de rate limits IA ni backpressure — ✅ RESUELTO

Diagnóstico: 429/5xx → `null` → "no pude extraer" + `completed` (mensaje
**descartado**, no diferido); sin backoff ni cap de concurrencia.

**Resuelto (#2/#5):** `withRetry` (backoff exponencial + jitter ante
429/408/5xx/red) en Anthropic/OpenAI; al agotar **propaga** → el item queda
`pending` y lo recupera el reprocesador (ya no se descarta). `maxInstances:
20` global acota el fan-out concurrente hacia los proveedores. Nota: la
contención es cap-por-instancias + backoff, no un throttle de TPM dedicado.

### 🟠 P1 — Duplicados por reintento de Twilio (carrera) — ✅ RESUELTO

Diagnóstico: `.add()` + `findByMessageSid` *read-then-write* sin transacción
→ doble gasto y doble costo IA (la dedupe corría tras Vision/Whisper).

**Resuelto (#3):** `twilioWebhook` encola con id determinístico
`= MessageSid` (`.doc(sid).create()`, `ALREADY_EXISTS` → 200 idempotente):
el duplicado **ni entra** al pipeline. `findByMessageSid` queda como
defensa en profundidad.

### 🟠 P1 — `softDeleteAll` rompía con >500 entradas — ✅ RESUELTO

Diagnóstico: `batch.commit()` único (límite Firestore 500) + sin hard-delete
real → `learning_log` sin cota.

**Resuelto (#4):** `softDeleteAll` paginado + `BulkWriter` (auto-batch
≤500); job `purgeDeletedLearningLog` (`onSchedule` diario, retención
`LEARNING_LOG_PURGE_DAYS`=30) hace el hard-delete vía `collectionGroup`.

### 🟡 P2 — Amplificación de lecturas/escrituras e invocaciones — ⚠️ PARCIAL

Diagnóstico: ~12–18 ops Firestore/mensaje; relectura de taxonomía por
mensaje; `onWhatsAppQueueFailed` dispara en cada update; `getRecentAmounts`
50 docs/gasto.

**Mitigado (#5):** `TtlCache` in-instance (60 s) elimina la relectura de
`getCategories`/`getPaymentMethods` por mensaje. **Aceptado/abierto:**
`onWhatsAppQueueFailed` sigue disparando en cada update (guard early-return,
costo ~nulo) y `getRecentAmounts` sigue leyendo 50 docs — bajo impacto, no
se tocó.

### 🟡 P2 — Validación post-IA — ⚠️ PARCIAL

Diagnóstico: `validateAmount` y dedupe corrían después de
Vision/Whisper/parse.

**Resuelto (#3):** el duplicado ya no llega al pipeline (id determinístico
en el webhook) → no se gasta IA en duplicados. **Aceptado:** `validateAmount`
sigue post-IA en imagen/voz (monto inválido en imagen es raro y de bajo
costo; no se reordenó `finalize` para no fragmentarlo).

### 🟢 P3 — Otros

- Clientes SDK instanciados por llamada → **✅ RESUELTO (#5):** singletons
  lazy por instancia (Twilio/Anthropic/OpenAI), reuso de pool TLS.
- `memory`/`timeoutSeconds` sin fijar → **✅ RESUELTO (#5):**
  `setGlobalOptions` (`memory: 512MiB`, `timeoutSeconds: 120`; overrides por
  función).
- Sin rate-limit/debounce por usuario; `pending_action` last-write-wins →
  **⛔ ABIERTO (aceptado):** fuera del alcance del bundle; reevaluar si
  aparece abuso real.
- Cold start (5 `defineSecret` + Admin SDK) → **⛔ ABIERTO (aceptado):** no
  se fijó `minInstances` (instancias siempre activas no se justifican al
  volumen actual).

---

## 5. Recomendaciones priorizadas

**Todas implementadas (#1–#6, P0→P2)** — build + lint + 36 tests en verde,
**sin desplegar aún**. Detalle en "Estado de remediación".

1. **(P0) Resucitar el reintento — ✅ Hecho.** `reprocessPendingQueue`
   (`onSchedule` 2 min): claim transaccional `pending→processing`, reinvoca
   `handleQueueDoc`, recupera `processing` huérfano. Se eligió `onSchedule`
   sobre `retry:true`/Cloud Tasks (aditivo y mínimo riesgo).
2. **(P0/P1) Resiliencia IA — ✅ Hecho.** `src/utils/retry.ts`
   (`withRetry`/`isTransientError`, backoff+jitter) en Anthropic/OpenAI;
   transitorio agotado → propaga y queda `pending`. `maxInstances: 20`.
3. **(P1) Dedupe sin carrera — ✅ Hecho.** `twilioWebhook` con id
   determinístico `= MessageSid` (`.doc(sid).create()` + `ALREADY_EXISTS`),
   antes de descargar media/llamar IA.
4. **(P1) `softDeleteAll` por chunks + hard-delete — ✅ Hecho.** Paginado +
   `BulkWriter`; job `purgeDeletedLearningLog` (`collectionGroup`, retención
   `LEARNING_LOG_PURGE_DAYS`).
5. **(P2) Config explícita + caché + singletons — ✅ Hecho.**
   `setGlobalOptions` (region/memory/timeout/maxInstances) + overrides por
   función; `TtlCache` de taxonomía; singletons SDK. `concurrency` se dejó
   en default a propósito (no estrangular el webhook).
6. **(P2) Observabilidad real — ✅ Hecho.** Evento `whatsapp_queue_stuck`
   (`reprocessPendingQueue`) + 2ª condición en `ops/alert-policy.json`
   (combiner OR).

Pendiente **operativo** (no es código): desplegar
(`firebase deploy --only functions`) y re-aplicar la alert policy
(`ops/README.md`). Abierto/aceptado: rate-limit por usuario y `minInstances`
(ver §4 P3).

---

## 6. Apéndice — inventario

### Funciones desplegadas (`index.ts`)

| Función | Tipo | Rol | Config |
|---|---|---|---|
| `twilioWebhook` | `onRequest` | Valida firma + encola (id = `MessageSid`) | `maxInstances:50`, conc. HTTP default |
| `processWhatsAppQueue` | `onDocumentCreated` | Pipeline principal | conc.=1; retry vía `reprocessPendingQueue` |
| `reprocessPendingQueue` | `onSchedule` (2 min) | Reprocesa `pending` + huérfanos + alerta `stuck` | `timeoutSeconds:300` |
| `purgeDeletedLearningLog` | `onSchedule` (24 h) | Hard-delete `learning_log` soft-deleted | retención `LEARNING_LOG_PURGE_DAYS` |
| `onWhatsAppQueueFailed` | `onDocumentUpdated` | Alerta `failed` (+ `stuck` vía scheduler) | dispara en cada update |
| `exportExpenses` | `onRequest` | Export CSV (Bearer ID token) | — |
| `healthCheck` | `onRequest` | Health | — |

> Config global (`setGlobalOptions`): `region: us-central1`, `memory:
> 512MiB`, `timeoutSeconds: 120`, `maxInstances: 20` (overrides arriba).

### Llamadas IA

| Llamada | Proveedor / tier | `max_tokens` | Cuándo |
|---|---|---|---|
| `extractReceiptData` | Anthropic Vision / `primary` (Sonnet) | 1024 | Imagen |
| `parseExpenseMessage` | Anthropic / `primary` (Sonnet) | 1024 | Texto fallback, voz |
| `parseRelativeDate` | Anthropic / `helper` (Haiku) | 128 | Fecha con pista temporal sin regex |
| `classifyAgainstTaxonomy` | Anthropic / `helper` (Haiku) | 128 | Miss de taxonomía+historial |
| `disambiguatePaymentMethod` | Anthropic / `helper` (Haiku) | 128 | Método ambiguo + hint |
| transcripción audio | OpenAI `gpt-4o-mini-transcribe` | — | Voz |

> Estado de confianza de los hallazgos: P0 "reintento muerto" verificado por
> ausencia total de reprocesador (`grep` de `onSchedule`/`onDocumentWritten`/
> `pubsub`/`retry:`/`status==pending` → 0 matches en `src/`). El resto por
> lectura directa de los flujos citados.
