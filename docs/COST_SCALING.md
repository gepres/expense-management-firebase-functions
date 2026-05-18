# Escalado de costo IA por cantidad de usuarios

> Perfil objetivo: **200.000 tokens Anthropic + 5 imágenes por usuario / mes**.
> Modelo construido sobre las **constantes de precio reales del código**
> (`src/services/usage.service.ts`) y la **cuota real** (`src/services/quota.service.ts`).
> Fuente de verdad de números: este repo al 2026-05-18. Todo lo no-IA
> (Firestore/Functions/Twilio) es paramétrico y va al final.

---

## 1. Constantes de precio (tal cual el código)

`usage.service.ts → pricing()` (defaults, override por env):

| Constante (env) | Default | Uso real en el bot |
|---|---|---|
| `AI_PRICE_ANTHROPIC_INPUT_PER_1M` | **$3 / 1M** | Todas las llamadas Anthropic (Sonnet **y** Haiku, sin distinguir) |
| `AI_PRICE_ANTHROPIC_OUTPUT_PER_1M` | **$15 / 1M** | idem |
| `AI_PRICE_WHISPER_PER_MIN_USD` | $0.006 / min | Voz (OpenAI transcribe) |
| `AI_PRICE_OPENAI_IMAGE_USD` | $0.04 / img | ⚠️ **No cableado**: ningún call-site registra `unitType:"image"` en este repo. Las imágenes se procesan con **Anthropic Vision** → su costo ya está dentro de los *tokens* Anthropic, no en esta constante. |

**Implicancia clave #1:** el costo de imagen NO es una línea aparte de $0.04.
Una imagen es una llamada Vision (tier `primary` = Sonnet) y se factura como
tokens de input/output Anthropic. Las "5 imágenes" ya están **incluidas** en
los 200.000 tokens.

**Implicancia clave #2:** el código estima Haiku al mismo precio que Sonnet
($3/$15). Haiku 4.5 real es ~3× más barato → **la estimación es conservadora
(sobreestima)** cuando hay muchas llamadas helper (fecha/taxonomía/método).

---

## 2. Modelo de costo por usuario / mes

Fórmula (Anthropic, que domina):

```
costo_usuario_mes = (T_in / 1e6) * 3  +  (T_out / 1e6) * 15
con  T_in + T_out = 200.000
```

El resultado depende del **split input/output**. En este pipeline las
salidas son JSON diminutos (`max_tokens` 128–1024, casi siempre <300) y las
entradas cargan prompt + imagen → es **input-heavy** (~85/15).

| Split in/out | T_in | T_out | Costo / usuario / mes |
|---|---|---|---|
| 100 / 0 (cota inferior) | 200.000 | 0 | **$0.60** |
| **85 / 15 (realista)** | 170.000 | 30.000 | **$0.96** |
| 70 / 30 | 140.000 | 60.000 | $1.32 |
| 50 / 50 (cota alta) | 100.000 | 100.000 | $1.80 |

**Escenario central adoptado: ≈ $0.96 / usuario / mes** (split 85/15).

### Desglose tangible de los 200.000 tokens

| Flujo | Tokens aprox / evento | Comentario |
|---|---|---|
| Imagen (Vision, Sonnet) | ~2.000 in + ~250 out ≈ **$0.010/img** | 5 img/mes ≈ **$0.05** (parte de los 200k) |
| Parse texto/voz (Sonnet) | ~500 in + ~150 out | el grueso del volumen |
| Helper (fecha/taxonomía/método, Haiku) | ~150 in + ~25 out | barato, esporádico |

200.000 tokens ÷ ~850 tokens por evento IA ≈ **~235 eventos IA / usuario / mes
(~8/día)** → es un **perfil de usuario intensivo**. Si tu usuario medio real
es más liviano, escalá los totales proporcionalmente (es lineal).

---

## 3. Escalado por cantidad de usuarios (solo IA Anthropic)

Costo **lineal** en nº de usuarios (sin economía de escala: es por token).

| Usuarios | Realista $0.96/mes | Alto $1.80/mes | Anual (realista) |
|---:|---:|---:|---:|
| 100 | $96 | $180 | $1.152 |
| 1.000 | $960 | $1.800 | $11.520 |
| 10.000 | $9.600 | $18.000 | $115.200 |
| 50.000 | $48.000 | $90.000 | $576.000 |
| 100.000 | $96.000 | $180.000 | $1.152.000 |
| 500.000 | $480.000 | $900.000 | $5.760.000 |
| 1.000.000 | $960.000 | $1.800.000 | $11.520.000 |

> Si querés contabilizar también la constante muerta de imagen ($0.04 × 5 =
> $0.20/usuario), sumá **+$0.20 × usuarios / mes** (p.ej. +$20.000/mes a
> 100k usuarios). Recomendación: **no** usarla — no refleja el costo real
> (Vision ≈ $0.05, ya dentro de los 200k).

---

## 4. La cuota es el techo real por usuario

`quota.service.ts` corta por `totalTokens` mensuales:

| Rol | `AI_QUOTA_*` default | Tope tokens/mes | Gasto IA máx/usuario/mes (85/15) |
|---|---|---:|---:|
| `standard` | `AI_QUOTA_STANDARD_TOKENS` | **100.000** | ~$0.48 (se **bloquea** antes de llegar a 200k) |
| `pro` | `AI_QUOTA_PRO_TOKENS` | **2.000.000** | ~$9.60 |
| `admin` | — | ∞ | sin tope |

**Conclusión:** el perfil de 200.000 tokens **solo es posible en usuarios
`pro` (o `admin`, o con env elevada)**. Un usuario `standard` se bloquea a
los 100k (~$0.48 gastado) y a partir de ahí solo usa comandos sin IA →
**la cuota es el cap de costo natural**. Para proyectar a escala, lo que
manda es el **mix de roles**, no solo el nº de usuarios:

```
costo_mes ≈ (n_standard * min(consumo, 100k) + n_pro * min(consumo, 2M)) ...
```

A 100k usuarios todos `standard` y todos saturando cuota: 100k × $0.48 =
**$48.000/mes** (no $96.000) — la cuota lo parte a la mitad respecto al
perfil 200k.

---

## 5. Costos NO-IA (paramétrico — fuera de las constantes del código)

A escala, **Twilio WhatsApp suele ser la línea más grande**, por encima de
la IA. Modelar aparte:

| Componente | Driver | Orden de magnitud (ajustar a tarifa Perú real) |
|---|---|---|
| **Twilio WhatsApp** | conversaciones/mes; el bot envía **2+ mensajes por entrada** (ej. "Procesando…" + resultado) | suele dominar; parametrizar `msgs_out × tarifa_conversación` |
| Firestore | ~12–18 ops/mensaje (lecturas+escrituras), sin caché de taxonomía | ~$0.06/100k lecturas, ~$0.18/100k escrituras |
| Cloud Functions | 1 `processWhatsAppQueue` + ~2 `onWhatsAppQueueFailed` por mensaje (amplificación) | 2M invocaciones gratis/mes, luego ~$0.40/M |
| Cloud Run cómputo | concurrencia=1 en event-trigger → instancias = mensajes simultáneos | GB-seg × tiempo de pipeline (imagen/voz 5–12 s) |
| Secret Manager / cold start | accesos en scale-from-zero | marginal |

Regla práctica: a >10k usuarios activos, **Twilio ≥ IA** en la factura.
Hacé el modelo de Twilio con la tarifa de conversación de tu país y
categoría (service/utility/marketing) antes de proyectar el total.

---

## 6. Palancas para reducir el costo (orden de impacto)

1. **Cuota agresiva por defecto** (ya existe): mantener `standard` bajo;
   `pro` como upsell. Es el control de costo #1.
2. **Recortar salidas**: las salidas pesan 5× el input. `max_tokens` ya
   está acotado; revisar que los prompts no induzcan JSON verboso.
3. **Menos llamadas Sonnet**: el orden "regex/reglas primero" ya evita IA
   en texto simple. Subir cobertura del regex y de taxonomía/historial
   baja el % que llega a Sonnet (la llamada cara).
4. **Helpers en Haiku** (ya): mantener fecha/taxonomía/método en tier
   `helper`. Costo real ~3× menor que lo estimado.
5. **Bajar mensajes Twilio salientes**: fusionar "Procesando…" + resultado
   cuando el pipeline es corto → ~−50% del costo Twilio (probablemente la
   mayor palanca económica global).
6. **Caché in-instance de taxonomía** (categorías/métodos por `userId`):
   reduce lecturas Firestore por mensaje.

---

## 7. Fórmula reutilizable

```
# Por usuario / mes (IA Anthropic)
T_in, T_out  = split de 200.000      # realista: 170.000 / 30.000
P_in, P_out  = 3, 15                 # USD / 1M (AI_PRICE_ANTHROPIC_*)
costo_user   = T_in/1e6*P_in + T_out/1e6*P_out          # ≈ $0.96

# A escala (mix de roles, con cuota)
consumo_efectivo = min(perfil_tokens, cuota_rol)        # std→100k, pro→2M
costo_total_mes  = Σ_roles  n_rol * costo(consumo_efectivo_rol)

# Total real
costo_total = costo_IA + costo_Twilio + costo_Firestore + costo_Functions
```

**Números cabeza de lista (perfil 200k + 5 img, split 85/15, solo IA):**

- $0.96 / usuario / mes
- 1.000 usuarios → ~$960/mes (~$11,5k/año)
- 100.000 usuarios → ~$96.000/mes (~$1,15M/año) — o **~$48.000/mes** si
  todos son `standard` (la cuota corta a 100k)
- 1.000.000 usuarios → ~$960.000/mes (~$11,5M/año)
- Twilio WhatsApp se modela aparte y a escala suele superar la IA.
