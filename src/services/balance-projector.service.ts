/**
 * Trigger fire-and-forget para que el backend (gastos-backend) debite el
 * sub-saldo del expense recién creado de inmediato, sin esperar al cron
 * de GitHub Actions (cada 5 min, hasta ~15 min en peor caso).
 *
 * Contrato (Opción A — desacople intacto): el bot escribe el expense con
 * `balanceApplied: false` y NO toca saldo. Este helper SOLO le pide al
 * backend que corra el proyector ahora; el backend sigue siendo el dueño
 * único del ledger. Si la llamada falla (timeout, 4xx/5xx, red), el cron
 * de GitHub Actions lo recoge igual a los ≤5 min.
 *
 * Fire-and-forget: no se `await`-ea, no propaga errores, no bloquea el
 * mensaje de confirmación al usuario. Timeout corto (3s) para no acumular
 * sockets si el backend está caído.
 *
 * Requiere `BACKEND_BASE_URL` (no-secret, .env, ej. https://x.vercel.app/api)
 * y `CRON_SECRET` (secret, defineSecret en index.ts). Sin AMBOS, no-op
 * silencioso — el cron sigue siendo la red de seguridad.
 */

import * as logger from "firebase-functions/logger";

const TIMEOUT_MS = 3000;

export function triggerBalanceProjection(expenseId: string): void {
  const baseUrl = process.env.BACKEND_BASE_URL;
  const secret = process.env.CRON_SECRET;
  if (!baseUrl || !secret) return;

  const url = `${baseUrl.replace(/\/+$/, "")}/expenses/cron/balance-run`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${secret}`,
      "Content-Type": "application/json",
    },
    signal: controller.signal,
  })
    .then((res) => {
      clearTimeout(timer);
      if (res.ok) {
        logger.info(`balance-projection triggered for ${expenseId}`, {
          status: res.status,
        });
      } else {
        // 4xx/5xx: el cron lo recoge igual. Warn, no error (no es ALERT).
        logger.warn("balance-projection trigger non-ok", {
          expenseId,
          status: res.status,
        });
      }
    })
    .catch((err) => {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      // Timeout/red/abort: idem, el cron lo recoge.
      logger.warn("balance-projection trigger error", { expenseId, msg });
    });
}
