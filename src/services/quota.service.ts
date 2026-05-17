import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

// Pre-chequeo de cuota IA del bot (Fase 2). Solo lectura; el cálculo es
// gemelo del QuotaService del backend (mismo doc, mismo mes UTC, mismas
// envs AI_QUOTA_*). El bot no genera imágenes → solo límite de tokens.
// admin = ilimitado.

export interface QuotaCheck {
  blocked: boolean;
  /** Fecha de reinicio para mostrar al usuario (DD/MM/YYYY). */
  resetAt: string;
  used: number;
  limit: number;
}

function monthKey(d: Date = new Date()): string {
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}`;
}

function resetDisplay(d: Date = new Date()): string {
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const dd = String(next.getUTCDate()).padStart(2, "0");
  const mm = String(next.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${next.getUTCFullYear()}`;
}

function tokenLimitForRole(role: string): number {
  if (role === "admin") return Infinity;
  if (role === "pro") {
    return Number(process.env.AI_QUOTA_PRO_TOKENS ?? 2000000);
  }
  return Number(process.env.AI_QUOTA_STANDARD_TOKENS ?? 100000);
}

// Best-effort: si algo falla (lectura de rol/rollup), NO bloquea (deja
// pasar). El backend es el guard duro; acá solo evitamos gasto extra y
// damos feedback temprano por WhatsApp.
export async function checkQuota(userId: string): Promise<QuotaCheck> {
  const resetAt = resetDisplay();
  try {
    const db = getFirestore();

    const userSnap = await db.collection("users").doc(userId).get();
    const role = (userSnap.exists ?
      (userSnap.data()?.role as string | undefined) :
      undefined) ?? "standard";

    const limit = tokenLimitForRole(role);
    if (!Number.isFinite(limit)) {
      return { blocked: false, resetAt, used: 0, limit };
    }

    const mes = monthKey();
    const rollSnap = await db
      .collection("aiUsageMonthly")
      .doc(`${userId}_${mes}`)
      .get();
    const used = rollSnap.exists ?
      Number(rollSnap.data()?.totalTokens) || 0 :
      0;

    return { blocked: used >= limit, resetAt, used, limit };
  } catch (err) {
    logger.error("checkQuota falló (no se bloquea, best-effort)", err);
    return { blocked: false, resetAt, used: 0, limit: 0 };
  }
}
