// Adaptador delgado: la lógica de modelos vive en `@gastos/expense-ai`
// (single source of truth, compartida con gastos-backend). Acá solo se
// inyecta el entorno (patrón CLAUDE.md §6: process.env vía .env bundleado).
//
// La regla `effort` (Sonnet 4.6+/Opus 4.5+; Haiku/Sonnet≤4.5 → 400) y los
// defaults viven en el paquete; este módulo mantiene la MISMA API que antes
// para no tocar los call-sites.

import {
  modelParams as sharedModelParams,
  transcribeModel as sharedTranscribeModel,
  modelFor as sharedModelFor,
  modelSupportsEffort as sharedModelSupportsEffort,
} from "@gastos/expense-ai";
import type { ModelTier, ModelRequestParams, ModelEnv } from "@gastos/expense-ai";

export type { ModelTier, ModelRequestParams };

function env(): ModelEnv {
  return {
    ANTHROPIC_MODEL_PRIMARY: process.env.ANTHROPIC_MODEL_PRIMARY,
    ANTHROPIC_MODEL_HELPER: process.env.ANTHROPIC_MODEL_HELPER,
    OPENAI_MODEL_TRANSCRIBE: process.env.OPENAI_MODEL_TRANSCRIBE,
  };
}

export function modelFor(tier: ModelTier): string {
  return sharedModelFor(tier, env());
}

export function modelSupportsEffort(model: string): boolean {
  return sharedModelSupportsEffort(model);
}

export function modelParams(tier: ModelTier): ModelRequestParams {
  return sharedModelParams(tier, env());
}

export function transcribeModel(): string {
  return sharedTranscribeModel(env());
}
