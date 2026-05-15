# Roadmap

Hoja de ruta consolidada para la siguiente fase de desarrollo. Reemplaza las secciones de roadmap dispersas en `README.md`, `CLAUDE.md` y `ARCHITECTURE.md`.

> Fecha base: 2026-05-14 · Versión actual: 2.1.0

---

## Fuentes

| Origen                                  | Aportes                                                  |
|-----------------------------------------|----------------------------------------------------------|
| `CLAUDE.md` § 7 (Trampas) y § 9 (Roadmap) | Deuda técnica y refactors prioritarios                 |
| `docs/ARCHITECTURE.md` § Trampas + § Roadmap | Deuda detallada + roadmap a tres horizontes         |
| `README.md` § Próximas Mejoras          | Visión producto                                          |
| Nuevas validaciones (sesión 2026-05-14) | § B — flujo de cuenta principal, fecha, clasificación   |
| Nota del usuario (sesión 2026-05-14)    | § G — IA en decisiones + historial de aprendizaje       |
| Decisiones F.1/F.2 (sesión 2026-05-14)  | § F — Wallet con saldo sincronizado + backfill al deploy |

---

## A. Recomendaciones ya documentadas

### A.1 Inferencia y matching
- [ ] Centralizar `isValidAudioType` (duplicado en `media-downloader.ts` y `transcription.service.ts`).
- [ ] Limpiar `voucherType` devuelto por `AnthropicService.parseExpenseMessage` (hoy se ignora en `index.ts`).
- [ ] Cache por invocación de `users/{uid}/categories` y `users/{uid}/payment_methods` (evita 1..N lecturas por mensaje).

### A.2 Reportes
- [ ] Fix `ExpenseService.getExpenseSummary` con `month` — hoy compara strings `YYYY-MM-01` contra `Timestamp`, nunca matchea. Usar `Timestamp.fromDate(new Date(year, month-1, 1))` + cota `< Timestamp.fromDate(new Date(year, month, 1))`.

### A.3 Infraestructura
- [x] Migrar `firebase-functions/v1` → `v2` (`onDocumentCreated`/`onRequest`).
- [x] Reemplazar `functions.config()` por `defineSecret` (runtime → `process.env`).
- [x] Absorber webhook de Twilio en este repo (`twilioWebhook` HTTPS function) en lugar de la Phase 1 externa.
- [x] Validar firma `X-Twilio-Signature` (rechaza 403 si inválida).
- [x] Tests de lógica pura con `node:test` (`npm test`). Falta cobertura Firestore/flujo (`firebase-functions-test`).

### A.4 Producto
- [~] Export: `exportExpenses` (HTTPS, CSV de `expenses`, auth por Firebase ID token). Falta export de `movements`/`learning_log` y formato Excel.
- [ ] Dashboard web — **proyecto frontend aparte** (fuera de este repo de Functions). El backend ya lo habilita vía `exportExpenses` (no requiere abrir `firestore.rules`).
- [ ] Alertas de presupuesto + alertas de saldo bajo (§ F.3).

---

## B. Nuevas validaciones (esta fase)

### B.1 Cuenta principal por defecto + cambio de cuenta + saldo

El bot WhatsApp trabaja sobre la **cuenta principal** del usuario por defecto. Cada cuenta tiene `saldo` sincronizado con la base de datos (§ F).

**Cambios necesarios:**
- Modelar `users/{uid}/accounts/{accountId}` con saldo (§ C.5).
- `processWhatsAppQueue`, tras resolver al usuario, resuelve la cuenta activa (algoritmo abajo).
- `ExpenseData.accountId` se añade al schema.
- Guardar el expense ahora es **transacción Firestore** que también actualiza `saldo` y registra un movement (§ F.1).

**Cambio de cuenta (decidido 2026-05-14):** por dos vías:
1. **Comando en WhatsApp** — override temporal en la conversación:
   - `usar cuenta <nombre>` (ej. `usar cuenta negocio`)
   - `cuenta actual` — muestra cuál está activa
   - `cuenta principal` — vuelve a la principal
2. **Configuración del usuario en la app** — cambia `isPrimary` (persistente).

**Resolución de cuenta activa por mensaje:**
```
1. ¿El usuario tiene una "cuenta de sesión" activa (override por comando)?
   → sí: usarla.
2. ¿Existe `accounts` con isPrimary == true?
   → sí: usarla.
3. ¿Existe al menos una `accounts`?
   → sí: usar la primera y marcarla isPrimary.
4. Crear cuenta "Principal" PEN con isPrimary == true (migración lazy).
```

La "cuenta de sesión" vive en `users/{uid}/whatsapp_session` con TTL (ej. 30 min de inactividad → vuelve a principal).

---

### B.2 Moneda heredada de la cuenta activa

La moneda del gasto **se hereda de la cuenta activa**.

**Prioridad:**
1. Moneda escrita explícitamente en el mensaje (`50 USD comida`) — disparar confirmación si difiere de la cuenta (§ C.4).
2. Moneda de la cuenta activa.
3. ~~Default `PEN`~~ (se elimina).

**Cambios:**
- `InferenceService.inferCurrency(text, defaultCurrency)` recibe la moneda de la cuenta.
- Se persiste `currencySource: "text" | "account"` en el expense (§ C.2).

---

### B.3 Validación dura de método de pago y monto

**Monto:**
- `monto > 0`, finito, hasta 2 decimales (redondear `Math.round(x * 100) / 100`).
- Si falla, rechazar con mensaje específico y `status: "completed"` + `error`.

**Método de pago:**
- Debe coincidir con `users/{uid}/payment_methods` o defaults (`yape`, `plin`, `efectivo`, `tarjeta`, `transferencia`).
- Si no se reconoce → `metodoPago: "otro"`, `needsReview: true`, sugerir crear el método.

**Detección atípica con IA (§ G.1):** si el monto supera N× la mediana del usuario, pedir confirmación antes de guardar.

**Validación contra saldo:** si el gasto deja saldo negativo, advertir antes de registrar (§ F.3).

---

### B.4 Validación de fecha real del gasto

**Decidido 2026-05-14:** estrategia **regex + LLM fallback**.

**Prioridad:**
1. **Fecha explícita** en texto/transcripción.
2. **Fecha del mensaje** (`whatsapp_queue.createdAt`).
3. ~~`new Date()` del processing~~ (se elimina).

**Parser:**
- **Regex** para casos comunes: `hoy`, `ayer`, `anteayer`/`antes de ayer`, `el N de <mes>`, `YYYY-MM-DD`, `DD/MM/YYYY`, `DD-MM-YYYY`.
- **LLM** para frases relativas (*"hace una semana"*, *"el lunes pasado"*, *"el viernes que viene"*).
- Si solo viene fecha sin hora → componer con la hora del mensaje.
- Persistir `dateSource: "regex" | "llm" | "message"` (§ C.2).

---

### B.5 Clasificación: `suggestions_ideas` → subcategoría → categoría → historial

Reemplaza `InferenceService.inferCategory`:

```
descripción normalizada
        │
        ▼
1. Match contra `suggestions_ideas` de cada subcategoría del usuario
        ├─ hit  → subcategoría = la dueña del suggestion
        │         categoría    = la dueña de esa subcategoría → DONE
        └─ miss
                ▼
2. Match contra `nombre` de subcategorías
        ├─ hit  → subcategoría = la matcheada
        │         categoría    = la dueña → DONE
        └─ miss
                ▼
3. Match contra `nombre` de categorías
        ├─ hit  → categoría = la matcheada
        │         subcategoría = null  (decidido 2026-05-14) → DONE
        └─ miss
                ▼
4. Consulta al historial del usuario (§ G.3)
        ├─ hit  → adoptar la clasificación previa → DONE
        └─ miss
                ▼
5. Sin relación → § B.6
```

**Implementación:**
- Normalización compartida (§ C.3).
- Match por **palabra completa** (tokenizar, no `includes`).
- Devolver `matchedTerm` y `matchedLevel` (`suggestion | subcategory | category | history | default`) para auditoría (§ C.2) y learning log (§ G.2).

---

### B.6 Sin relación → registrar y sugerir creación

**Decidido 2026-05-14:** registrar primero.

- `categoria: "sin_clasificar"`, `subcategoria: null`, `needsClassification: true`.
- Twilio responde sugiriendo crear la categoría/subcategoría.
- Comando `pendientes` (§ C.6) permite revisar y clasificar después.
- Cada clasificación alimenta `learning_log` (§ G.2).

---

## C. Puntos adicionales

### C.1 Idempotencia por `MessageSid`
- Guardar `messageSid` en `whatsapp_queue` y en `expenses`.
- Antes de `saveExpense`, verificar que no exista `expense.messageSid == X`.

### C.2 Auditoría denormalizada en cada expense

```ts
{
  matchedTerm: string | null;
  matchedLevel: "suggestion" | "subcategory" | "category" | "history" | "default";
  currencySource: "text" | "account" | "default";
  dateSource:     "regex" | "llm" | "message" | "default";
  paymentMethodSource: "text" | "inferred" | "fallback";
}
```

Complementa § G.2 (log completo en colección aparte).

### C.3 Normalización compartida
`MessageParser.normalizeForMatching(text)` con `lowercase + strip diacríticos + collapse whitespace + trim`. Una sola implementación, usada en parsing y matching.

### C.4 Validación de coherencia
- Método de pago referenciado pero no existe en la cuenta → flag.
- Moneda explícita ≠ moneda de la cuenta activa → confirmación (*"Tu cuenta principal es PEN. ¿Confirmas el gasto en USD?"*).

### C.5 Schema de `accounts`

```ts
users/{uid}/accounts/{accountId}
{
  nombre: string;             // "Personal", "Negocio", ...
  isPrimary: boolean;         // exactamente una true por usuario
  moneda: string;             // PEN | USD | EUR | ...
  tipo?: "personal" | "negocio" | "compartida";
  saldo: number;              // caché denormalizado; fuente de verdad: movements (§ F.1)
  saldoInicial: number;       // primer aporte; persistido como movement "apertura" al crear
  saldoMinimoAlerta?: number; // si saldo < este valor, alerta opcional al usuario
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
```

En expenses:
```ts
accountId: string;
```

### C.6 Comando `pendientes` / `clasificar`
- Lista expenses con `needsClassification: true` o `needsReview: true`.
- Permite asignar categoría/subcategoría/método desde WhatsApp.
- Cada corrección se loggea en `learning_log` (§ G.2).

---

## D. Orden de implementación sugerido

| Orden | Bloque                       | Razón                                                       |
|-------|------------------------------|-------------------------------------------------------------|
| 1     | § C.5 + § F (schemas)        | `accounts` + `movements` antes que cualquier otra cosa      |
| 2     | § F.6 backfill al deploy     | Migración a `accountId` cuando schemas están listos         |
| 3     | § G.2 `learning_log` schema  | Listo antes de tocar inferencia                             |
| 4     | § B.1 + § B.2                | Cuenta activa + moneda heredada                             |
| 5     | § F.1 + F.2 (gasto en tx)    | Transacción gasto + movement + saldo en `saveExpense`       |
| 6     | § A.1 + § C.3                | Centralización antes del refactor de inferencia             |
| 7     | § B.5 + § G.3                | Nuevo flujo de clasificación + consulta al historial        |
| 8     | § B.3 + § B.4                | Validaciones duras (monto, método, fecha)                   |
| 9     | § F.2 ingresos + transferencias | Comandos `ingreso`, `transferir`, `saldo`               |
| 10    | § B.6 + § C.6 + § G.5        | Pendientes + comandos de revisión                           |
| 11    | § C.1 + § C.2                | Idempotencia + auditoría denormalizada                      |
| 12    | § G.1 (decisiones IA)        | Integrar IA donde aún no esté                               |
| 13    | § A.2                        | Fix `getExpenseSummary`                                     |
| 14    | § A.3                        | Functions v2 + secrets + webhook absorbido                  |
| 15    | § A.4                        | Tests + dashboard + export                                  |

Bloques 1–5 forman el **piso de la fase** (cuentas + saldo funcionando). 6–10 cierran las validaciones y la capa de IA. 11–15 son cleanup/infra.

---

## E. Decisiones tomadas (2026-05-14)

| Pregunta                                                              | Respuesta                                                                         |
|-----------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| Cambio de cuenta en conversación                                      | **Sí**, por comando WhatsApp **y** configuración del usuario (§ B.1)              |
| § B.6 — antes vs después de registrar                                 | **Después**, con `needsClassification: true` (§ B.6)                              |
| Parser de fechas                                                      | **Regex + LLM fallback** (§ B.4)                                                  |
| Subcategoría default cuando solo matchea categoría (§ B.5 paso 3)     | **`null`** — solo la categoría (§ B.5)                                            |
| § F.1 — Saldo en `accounts`                                           | **Opción B** — Wallet con saldo **sincronizado** vía transacciones Firestore (§ F)|
| § F.2 — Migración de expenses históricos                              | **Opción A** — Backfill automático al deploy (§ F.6)                              |

---

## F. Wallet con saldo — diseño detallado

Decidido § E.5 y § E.6: cada cuenta tiene saldo **sincronizado con la base de datos**. La fuente de verdad son los movimientos (ledger append-only); `accounts.saldo` es un caché denormalizado actualizado en la misma transacción.

### F.1 Colección `movements` (ledger)

`users/{uid}/movements/{movementId}` — **append-only**:

```ts
{
  accountId: string;
  tipo: "gasto" | "ingreso" | "transferencia_in" | "transferencia_out" | "ajuste" | "reversion";
  monto: number;                      // siempre positivo; el signo lo da `tipo`
  signoEfectivo: -1 | 1;              // -1 para gasto/transferencia_out, +1 para ingreso/transferencia_in
  expenseId?: string;                 // si tipo == "gasto" o "reversion"
  transferPairId?: string;            // si tipo == "transferencia_*", apunta al movimiento contraparte
  descripcion: string;
  fecha: Timestamp;                   // fecha efectiva (puede diferir de createdAt)
  saldoAnterior: number;
  saldoNuevo: number;
  metadata?: { aperturaInicial?: boolean; ajusteManual?: boolean };
  createdAt: Timestamp;
}
```

**Reglas:**
- Nunca se borra ni edita un movimiento. Correcciones se hacen con `reversion` o `ajuste`.
- Es la **fuente de verdad** del saldo. `accounts.saldo` es caché.
- Toda operación corre dentro de `db.runTransaction()`:
  1. Lee `accounts/{accId}`.
  2. Calcula `saldoNuevo`.
  3. Escribe `expenses/{id}` (si aplica).
  4. Escribe `movements/{id}` con `saldoAnterior` y `saldoNuevo`.
  5. Actualiza `accounts.saldo = saldoNuevo`.

### F.2 Operaciones soportadas

| Operación              | Trigger                                          | Efecto                                                                       |
|------------------------|--------------------------------------------------|------------------------------------------------------------------------------|
| Crear gasto            | Pipeline normal `processWhatsAppQueue`           | `saldo -= monto`; movement `gasto` con `expenseId`                          |
| Registrar ingreso      | Comando `ingreso <monto> <descripcion>`          | `saldo += monto`; movement `ingreso`                                         |
| Consultar saldo        | Comando `saldo` o `mi saldo`                     | Lee `accounts.saldo` de la cuenta activa (o todas con `saldo de cuentas`)    |
| Transferencia          | Comando `transferir <monto> a <cuenta>`          | 2 movements (`transferencia_out` + `transferencia_in`); transacción atómica  |
| Ajuste manual          | Comando `ajustar saldo a <monto>` o UI           | Movement `ajuste` con la diferencia (puede ser positivo o negativo)          |
| Borrar gasto           | UI o comando `borrar gasto <id>`                 | Movement `reversion` con `expenseId`; saldo se recupera                      |
| Editar monto de gasto  | UI                                               | Movement `ajuste` con la diferencia; el expense original conserva su monto antes de edición o se marca `editedAt` |

> **Comandos en esta fase:** `ingreso`, `saldo`, `transferir`. Edición y borrado vía UI quedan para el dashboard (§ A.4).

### F.3 Saldo inicial, validaciones y alertas

- **Apertura:** al crear una `account`, el usuario puede aportar `saldoInicial`. Se persiste un movement `ingreso` con `metadata.aperturaInicial: true` y descripción "Apertura de cuenta".
- **Saldo negativo permitido**, pero:
  - Antes de guardar un gasto que deja `saldoNuevo < 0`, enviar confirmación al usuario: *"Este gasto dejará tu saldo en S/ -X. ¿Confirmas?"*.
  - Si `accounts.saldoMinimoAlerta` está fijado y `saldoNuevo < saldoMinimoAlerta`, enviar alerta tras el registro.
- **Transferencias:**
  - Validar que la cuenta destino exista y pertenezca al mismo usuario.
  - Misma moneda en origen y destino (en esta fase no hay conversión). Si difieren, rechazar y pedir cambio explícito.

### F.4 Consultas

- **Saldo actual:** `accounts.saldo` (1 lectura).
- **Saldo a fecha X:** `SUM(movements where fecha ≤ X)` — útil para reportes.
- **Movimientos por cuenta/tipo/fecha:** queries sobre `movements`.
- **Índices:**
  - `users/{uid}/movements` por `accountId + fecha DESC`
  - `users/{uid}/movements` por `accountId + tipo`
  - `users/{uid}/movements` por `expenseId` (para localizar reversiones)

### F.5 Comandos WhatsApp añadidos

| Comando                              | Acción                                                          |
|--------------------------------------|-----------------------------------------------------------------|
| `saldo`                              | Saldo de la cuenta activa                                       |
| `saldo de cuentas`                   | Saldo de todas las cuentas del usuario                          |
| `ingreso <monto> <descripcion>`      | Registra un ingreso en la cuenta activa                         |
| `transferir <monto> a <cuenta>`      | Transferencia desde la cuenta activa a otra del mismo usuario   |
| `movimientos`                        | Últimos N movements de la cuenta activa                         |
| `usar cuenta <nombre>`               | Cambia la cuenta activa de la sesión (§ B.1)                    |

### F.6 Migración al deploy (decidido § F.2 Opción A)

Script de migración ejecutado **una vez al activar la feature**:

1. Para cada `users/{uid}` sin `accounts`:
   - Crear `accounts/{Principal}` con `isPrimary: true`, `moneda: "PEN"`, `saldo: 0`, `saldoInicial: 0`.
2. Para cada `expenses/{id}` sin `accountId` (en batches por usuario):
   - Update `accountId = <Principal del usuario>`.
3. **No se generan movements retroactivos** para los gastos históricos. El ledger empieza desde la fecha del deploy. Después de la migración:
   - `accounts.saldo = 0`.
   - El usuario fija su saldo real con `ajustar saldo a <monto>` o `ingreso <monto> apertura`.

**Trade-off:** mantener el migrate simple y dejar al usuario decidir el saldo de partida; alternativa era reproducir movements históricos pero requiere pedirle el saldo inicial al usuario y complica el script.

**Idempotencia del script:** corre safe si se ejecuta dos veces (skip si la cuenta `Principal` ya existe y todos los expenses ya tienen `accountId`).

---

## G. IA en decisiones + Historial de aprendizaje por usuario

**Principio (nota del usuario, 2026-05-14):** cada registro debe ser **acorde al usuario y a sus decisiones previas**. La IA se usa en los puntos importantes y queda un backup completo del aprendizaje para retroalimentar futuras decisiones.

### G.1 Dónde usa IA el sistema

| Decisión                              | Mecanismo                                | Cuándo                                |
|---------------------------------------|------------------------------------------|---------------------------------------|
| Parseo de texto libre                 | Anthropic `parseExpenseMessage`          | Cuando el regex no acierta            |
| Transcripción de audio                | Whisper                                  | Siempre (audio)                       |
| Lectura de comprobantes               | Anthropic Vision                         | Siempre (imagen)                      |
| Fecha relativa compleja               | Anthropic (§ B.4)                        | Cuando el regex no parsea             |
| Clasificación cuando suggestions falla| Anthropic con contexto de categorías     | § B.5 paso 4 / pre-paso a § B.6       |
| Detección de monto atípico            | Comparación vs mediana del usuario + LLM | Antes de guardar, si supera umbral    |
| Resolución de método de pago ambiguo  | Anthropic con lista del usuario          | Cuando hay múltiples candidatos       |

### G.2 Schema del historial de aprendizaje

`users/{uid}/learning_log/{entryId}` — **append-only**:

```ts
{
  expenseId?: string;
  type: "classification" | "currency" | "date" | "payment" | "amount" | "user_correction";
  input: {
    raw: string;
    normalized: string;
    channel: "text" | "image" | "audio";
  };
  decision: {
    field: string;
    value: string | number;
    source: "regex" | "llm" | "history" | "user_correction" | "default";
    matchedTerm?: string;
    confidence?: number;             // 0..1 si viene de LLM
  };
  userFeedback?: {
    correctedValue: string | number;
    at: Timestamp;
    via: "wsp_command" | "app_ui";
  };
  createdAt: Timestamp;
}
```

Complementario a § C.2 (audit denormalizado en `expenses`). C.2 es para queries rápidas; G.2 es la fuente de verdad para entrenamiento y export.

### G.3 Usar el historial en decisiones futuras

Paso 4 de § B.5: antes de caer en "sin clasificar", consultar `learning_log`.

**Implementación inicial:**
- Query top-N entradas con `input.normalized` que comparta ≥1 palabra clave.
- Si una entrada tiene `userFeedback.correctedValue` para `categoria`, adoptarla.
- Devolver `matchedLevel: "history"`.

**Más adelante (opcional):** embedding/vector search.

### G.4 Backup y export
- `learning_log` es **append-only**.
- Incluir en el export CSV (§ A.4).
- Sirve como evidencia auditable de cómo se tomó cada decisión.

### G.5 Comando `mi historial` / `aprendizajes`
- Lista las últimas N decisiones del usuario.
- Permite corregir; la corrección persiste en `userFeedback` y prioriza esa asignación en futuras descripciones similares (loop de aprendizaje).

### G.6 Privacidad y borrado
- Comando `olvidar historial` → soft delete (`deletedAt`).
- Hard delete tras N días (configurable, default 30).

---

## H. Lo que **no** está en esta fase (referencia)

- Multi-usuario / familia (compartir cuentas).
- ML / embeddings para clasificación (queda como evolución de § G.3).
- Presupuestos (alertas de saldo bajo sí están — § F.3).
- Migración de modelo NLU.
- Edición de expenses desde WhatsApp (queda para el dashboard).
- Transferencias entre monedas distintas (§ F.3).

---

**Última actualización:** 2026-05-14
