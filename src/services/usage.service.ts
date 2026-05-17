import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

/**
 * Registro de consumo IA (Fase 1) — gemelo del UsageService del backend.
 * Mismo esquema Firestore que el backend (top-level → write bloqueado al
 * cliente por rules; el panel admin lo agrega indistinto):
 *  - aiUsageEvents/{id}               (auditoría, 1 por llamada)
 *  - aiUsageMonthly/{uid}_{YYYY-MM}   (rollup usuario, scope "user")
 *  - aiUsageAppMonthly/{YYYY-MM}      (rollup app)
 * `repo: "functions"`. Best-effort: nunca lanza (no rompe el bot).
 */

export type UsageScope = "app" | "user";
export type UsageProvider = "anthropic" | "openai";

export interface UsageContext {
  userId?: string | null;
  scope: UsageScope;
  feature: string;
}

export interface RecordUsageParams extends UsageContext {
  provider: UsageProvider;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  units?: number;
  unitType?: "image" | "audio_seconds";
  status?: "ok" | "error";
  meta?: Record<string, unknown>;
}

function monthKey(d: Date = new Date()): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}`;
}

function pricing() {
  return {
    anthropicInputPer1M: Number(
      process.env.AI_PRICE_ANTHROPIC_INPUT_PER_1M ?? 3
    ),
    anthropicOutputPer1M: Number(
      process.env.AI_PRICE_ANTHROPIC_OUTPUT_PER_1M ?? 15
    ),
    openaiImageUsd: Number(process.env.AI_PRICE_OPENAI_IMAGE_USD ?? 0.04),
    whisperPerMinUsd: Number(process.env.AI_PRICE_WHISPER_PER_MIN_USD ?? 0.006),
  };
}

function estimateCostUsd(p: RecordUsageParams): number {
  const pr = pricing();
  if (p.provider === "anthropic") {
    const inUsd = ((p.inputTokens ?? 0) / 1000000) * pr.anthropicInputPer1M;
    const outUsd = ((p.outputTokens ?? 0) / 1000000) * pr.anthropicOutputPer1M;
    return Number((inUsd + outUsd).toFixed(6));
  }
  if (p.provider === "openai") {
    if (p.unitType === "image") {
      return Number(((p.units ?? 1) * pr.openaiImageUsd).toFixed(6));
    }
    if (p.unitType === "audio_seconds") {
      return Number((((p.units ?? 0) / 60) * pr.whisperPerMinUsd).toFixed(6));
    }
  }
  return 0;
}

export async function recordUsage(p: RecordUsageParams): Promise<void> {
  try {
    const db = getFirestore();
    const now = Timestamp.now();
    const mes = monthKey();
    const totalTokens = (p.inputTokens ?? 0) + (p.outputTokens ?? 0);
    const estimatedCostUsd = estimateCostUsd(p);

    const event = {
      userId: p.userId ?? null,
      scope: p.scope,
      feature: p.feature,
      provider: p.provider,
      model: p.model,
      inputTokens: p.inputTokens ?? 0,
      outputTokens: p.outputTokens ?? 0,
      totalTokens,
      units: p.units ?? null,
      unitType: p.unitType ?? null,
      estimatedCostUsd,
      status: p.status ?? "ok",
      repo: "functions" as const,
      mes,
      meta: p.meta ?? null,
      createdAt: now,
    };

    const inc = (n: number) => FieldValue.increment(n);
    const rollup = {
      mes,
      totalTokens: inc(totalTokens),
      inputTokens: inc(p.inputTokens ?? 0),
      outputTokens: inc(p.outputTokens ?? 0),
      estimatedCostUsd: inc(estimatedCostUsd),
      calls: inc(1),
      byFeature: {
        [p.feature]: {
          tokens: inc(totalTokens),
          calls: inc(1),
          costUsd: inc(estimatedCostUsd),
        },
      },
      byProvider: {
        [p.provider]: {
          tokens: inc(totalTokens),
          calls: inc(1),
          costUsd: inc(estimatedCostUsd),
        },
      },
      updatedAt: now,
    };

    await db.collection("aiUsageEvents").add(event);

    if (p.scope === "user" && p.userId) {
      // Top-level (NO subcolección de users): evita que la regla recursiva
      // users/{uid}/{document=**} dé write al dueño (manipular su cuota).
      await db
        .collection("aiUsageMonthly")
        .doc(`${p.userId}_${mes}`)
        .set(
          { userId: p.userId, scope: "user", ...rollup },
          { merge: true }
        );
    } else {
      await db
        .collection("aiUsageAppMonthly")
        .doc(mes)
        .set(rollup, { merge: true });
    }
  } catch (err) {
    logger.error(
      "No se pudo registrar el consumo IA (ignorado, best-effort)",
      err
    );
  }
}
