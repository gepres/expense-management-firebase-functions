// Config de modelos Anthropic por "tier", resuelta desde env (no-secreto;
// patrón de CLAUDE.md §6: process.env vía .env bundleado al deploy).
//
// Por qué un módulo y no strings sueltos: el parámetro `output_config.effort`
// SOLO lo aceptan Sonnet 4.6+ y Opus 4.5+. Haiku 4.5 y Sonnet 4.5/anteriores
// devuelven 400 si se les envía `effort`. Si el modelo es variable de
// entorno, esa regla no puede vivir hardcodeada en cada call-site: vive aquí,
// acoplada al modelo que efectivamente se resuelve.

export type ModelTier = "primary" | "helper";

// Defaults = los modelos vigentes tras la migración 2026-05. Si la env falta,
// producción NO se cae: cae a estos.
const DEFAULTS: Record<ModelTier, string> = {
  primary: "claude-sonnet-4-6", // vision (comprobantes) + parse principal
  helper: "claude-haiku-4-5", // fallbacks acotados (fecha/taxonomía/método)
};

const ENV_VARS: Record<ModelTier, string> = {
  primary: "ANTHROPIC_MODEL_PRIMARY",
  helper: "ANTHROPIC_MODEL_HELPER",
};

export function modelFor(tier: ModelTier): string {
  return process.env[ENV_VARS[tier]]?.trim() || DEFAULTS[tier];
}

// `effort` (GA, sin beta header) lo soportan Sonnet 4.6+ y Opus 4.5+.
// Default conservador: si NO reconocemos el modelo, NO mandamos effort.
// Razón: un falso positivo (effort a un modelo que no lo acepta) es un 400
// que rompe la llamada; omitirlo de más solo cuesta algo de latencia/tokens.
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return false;
  if (
    m.includes("opus-4-5") ||
    m.includes("opus-4-6") ||
    m.includes("opus-4-7")
  ) {
    return true;
  }
  if (m.includes("sonnet-4-6") || m.includes("sonnet-4-7")) return true;
  return false;
}

export interface ModelRequestParams {
  model: string;
  // thinking off siempre: estas son tareas de extracción/clasificación
  // acotadas; el razonamiento abierto solo agrega costo y latencia.
  thinking: { type: "disabled" };
  output_config?: { effort: "low" };
}

export function modelParams(tier: ModelTier): ModelRequestParams {
  const model = modelFor(tier);
  const params: ModelRequestParams = {
    model,
    thinking: { type: "disabled" },
  };
  if (modelSupportsEffort(model)) {
    params.output_config = { effort: "low" };
  }
  return params;
}

// ── OpenAI (transcripción de audio) ──────────────────────────────────
// El audio NO va por Claude (no transcribe); usa OpenAI. Aquí solo es un
// string de modelo (sin la regla effort/thinking de Anthropic), pero se
// resuelve por env con el mismo patrón para rollback/canary sin código.
// Default = gpt-4o-mini-transcribe (mitad de costo que whisper-1, menor
// WER). Alternativa de máxima precisión: gpt-4o-transcribe.
const DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

export function transcribeModel(): string {
  return process.env.OPENAI_MODEL_TRANSCRIBE?.trim() ||
    DEFAULT_TRANSCRIBE_MODEL;
}
