import * as logger from "firebase-functions/logger";

/**
 * Reintento con backoff exponencial + jitter para errores TRANSITORIOS de
 * APIs externas (Anthropic / OpenAI / red). Rec. #2 de docs/AUDIT.md.
 *
 * `isTransientError` es PURO (testeable sin IO). `withRetry` reintenta solo
 * si el error es transitorio; un error definitivo (4xx ≠ 429/408, JSON
 * inválido, etc.) se relanza inmediatamente sin gastar reintentos.
 */

export interface RetryOptions {
  /** Reintentos ADICIONALES tras el primer intento (default 2 → 3 totales). */
  retries?: number;
  /** Backoff base en ms (default 400). */
  baseDelayMs?: number;
  /** Tope del backoff en ms (default 4000). */
  maxDelayMs?: number;
  /** Etiqueta para los logs. */
  label?: string;
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "ENOTFOUND",
  "ECONNABORTED",
]);

const TRANSIENT_ERROR_NAMES = new Set([
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "APITimeoutError",
  "RateLimitError",
  "InternalServerError",
]);

/**
 * ¿El error amerita reintento? 429 (rate limit), 408 (timeout), 5xx, o
 * fallos de red/transporte. Los SDK de Anthropic/OpenAI exponen `status`;
 * axios usa `code`/`response.status`. Conservador: ante la duda, NO es
 * transitorio (no reintentar un 400 cuesta una respuesta de error al
 * usuario; reintentar uno definitivo gasta latencia y cuota).
 * @param {unknown} err Error a clasificar.
 * @return {boolean} true si conviene reintentar.
 */
/**
 * ¿El error es "saldo insuficiente" de Anthropic? La API devuelve 400 con
 * `error.error.message` = "Your credit balance is too low …". NO es
 * transitorio (no reintentar), pero amerita un mensaje distinto al
 * usuario para que avise al admin en vez de creer que su gasto está mal.
 * @param {unknown} err Error a clasificar.
 * @return {boolean} true si Anthropic reportó saldo bajo.
 */
export function isLowBalanceError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    message?: string;
    error?: { error?: { message?: string } };
  };
  if (e.status !== 400) return false;
  const inner = e.error?.error?.message;
  if (typeof inner === "string" && /credit balance is too low/i.test(inner)) {
    return true;
  }
  if (
    typeof e.message === "string" &&
    /credit balance is too low/i.test(e.message)
  ) {
    return true;
  }
  return false;
}

export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    statusCode?: number;
    code?: string | number;
    name?: string;
    response?: { status?: number };
  };

  const status =
    typeof e.status === "number" ? e.status :
      typeof e.statusCode === "number" ? e.statusCode :
        typeof e.response?.status === "number" ? e.response.status :
          undefined;
  if (status !== undefined) {
    if (status === 429 || status === 408) return true;
    if (status >= 500 && status <= 599) return true;
  }

  if (typeof e.code === "string" && NETWORK_CODES.has(e.code)) return true;
  if (typeof e.name === "string" && TRANSIENT_ERROR_NAMES.has(e.name)) {
    return true;
  }
  return false;
}

/**
 * Ejecuta `fn` reintentando ante errores transitorios. Al agotar los
 * reintentos (o ante un error definitivo) relanza el último error para que
 * el caller decida (en este repo: propagar → el item queda `pending` y lo
 * recupera `reprocessPendingQueue`).
 * @param {Function} fn Operación a ejecutar.
 * @param {RetryOptions} opts Opciones de reintento.
 * @return {Promise<T>} Resultado de `fn`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 400;
  const max = opts.maxDelayMs ?? 4000;
  const tag = opts.label ? ` (${opts.label})` : "";
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !isTransientError(err)) break;
      const expo = Math.min(max, base * 2 ** attempt);
      const delay = Math.round(expo / 2 + Math.random() * (expo / 2));
      logger.warn(
        `withRetry: error transitorio${tag}, intento ` +
          `${attempt + 1}/${retries + 1}, reintentando en ${delay}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
