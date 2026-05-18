/**
 * Caché en memoria por instancia con TTL. NO es distribuido: vive en la
 * instancia de Cloud Run y se pierde al reciclarla. Sirve para no re-leer
 * datos casi estáticos (taxonomía del usuario) en CADA mensaje (rec. #5
 * docs/AUDIT.md). Staleness tolerada: hasta `ttlMs` tras un cambio en la
 * app web — aceptable para categorías/métodos de pago.
 */
export class TtlCache<T> {
  private store = new Map<string, { at: number; value: T }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number = 60_000, maxEntries: number = 1000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.at > this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    // Cache por instancia: si pasan muchos usuarios por la misma, evitar
    // crecer sin cota (limpieza simple total al tope; es efímero).
    if (this.store.size >= this.maxEntries) this.store.clear();
    this.store.set(key, { at: Date.now(), value });
  }
}
