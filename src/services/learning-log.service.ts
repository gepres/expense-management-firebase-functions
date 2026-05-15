import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  LearningLogEntry,
  LearningLogEntryInput,
  LearningLogFeedback,
} from "../types";

const TOKEN_MIN_LENGTH = 3;
const TOKEN_STOPWORDS = new Set([
  "del",
  "las",
  "los",
  "por",
  "con",
  "para",
  "que",
  "una",
  "uno",
  "soles",
  "sol",
  "gaste",
  "pague",
  "compre",
]);

// Tokeniza una descripción normalizada para queries de similaridad
// (Firestore array-contains-any). Tokens ≥ 3 chars, sin stopwords ES.
// Cap a 10 (límite de array-contains-any).
export function tokenizeForLearning(normalized: string): string[] {
  const words = normalized
    .split(/[^a-z0-9]+/i)
    .filter((w) => w.length >= TOKEN_MIN_LENGTH && !TOKEN_STOPWORDS.has(w));
  const unique = Array.from(new Set(words));
  return unique.slice(0, 10);
}

// Solape entre dos sets de tokens: |∩| / min(|a|,|b|) (overlap coef).
// Más tolerante que Jaccard a diferencias de longitud: una corrección
// corta ("taxi") debe seguir aplicando a "taxi al centro comercial".
// 0 si alguno está vacío. Tokens ya únicos (tokenizeForLearning).
export function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter++;
  }
  return inter / Math.min(setA.size, setB.size);
}

// Bitácora append-only de decisiones de inferencia para personalizar
// futuras decisiones del bot por usuario. ROADMAP § G.
export class LearningLogService {
  private db: FirebaseFirestore.Firestore;

  constructor() {
    this.db = getFirestore();
  }

  private col(userId: string): FirebaseFirestore.CollectionReference {
    return this.db.collection("users").doc(userId).collection("learning_log");
  }

  async append(
    userId: string,
    entry: LearningLogEntryInput
  ): Promise<string | null> {
    try {
      const docRef = this.col(userId).doc();
      // Firestore rechaza `undefined` (incl. anidado): podar opcionales.
      const decision: Record<string, unknown> = {
        field: entry.decision.field,
        value: entry.decision.value,
        source: entry.decision.source,
      };
      if (entry.decision.matchedTerm !== undefined) {
        decision.matchedTerm = entry.decision.matchedTerm;
      }
      if (entry.decision.confidence !== undefined) {
        decision.confidence = entry.decision.confidence;
      }
      const doc: Record<string, unknown> = {
        type: entry.type,
        input: entry.input,
        decision,
        tokens: tokenizeForLearning(entry.input.normalized),
        createdAt: Timestamp.now(),
      };
      if (entry.expenseId !== undefined) {
        doc.expenseId = entry.expenseId;
      }
      await docRef.set(doc);
      return docRef.id;
    } catch (error) {
      logger.error("Error appending learning_log entry:", error);
      return null;
    }
  }

  // Busca entradas relevantes en el historial del usuario para una
  // descripción. Prioriza entradas con `userFeedback` (correcciones
  // explícitas) sobre decisiones automáticas. ROADMAP § B.5 paso 4 / § G.3.
  async queryRelevant(
    userId: string,
    normalized: string,
    options?: { limit?: number; type?: LearningLogEntryInput["type"] }
  ): Promise<LearningLogEntry[]> {
    const tokens = tokenizeForLearning(normalized);
    if (tokens.length === 0) return [];
    const limit = options?.limit ?? 20;
    try {
      let query: FirebaseFirestore.Query = this.col(userId).where(
        "tokens",
        "array-contains-any",
        tokens
      );
      if (options?.type) {
        query = query.where("type", "==", options.type);
      }
      const snap = await query.limit(limit).get();
      const entries = snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<LearningLogEntry, "id">) }))
        .filter((e) => !e.deletedAt);
      // Correcciones explícitas primero (señal más fuerte). El marcador
      // real de corrección es `type`/`decision.source === "user_correction"`
      // (el comando `clasificar` hace append de una entrada nueva, no setea
      // `userFeedback`; se mantiene en el OR por si algún día se popula).
      const isCorrection = (e: LearningLogEntry): boolean =>
        e.type === "user_correction" ||
        e.decision.source === "user_correction" ||
        !!e.userFeedback;
      entries.sort((a, b) => {
        const ac = isCorrection(a) ? 1 : 0;
        const bc = isCorrection(b) ? 1 : 0;
        if (ac !== bc) return bc - ac;
        return b.createdAt.toMillis() - a.createdAt.toMillis();
      });
      return entries;
    } catch (error) {
      logger.error("Error querying relevant learning entries:", error);
      return [];
    }
  }

  async recordUserFeedback(
    userId: string,
    entryId: string,
    feedback: Omit<LearningLogFeedback, "at"> & { at?: Timestamp }
  ): Promise<boolean> {
    try {
      const payload: LearningLogFeedback = {
        correctedValue: feedback.correctedValue,
        at: feedback.at ?? Timestamp.now(),
        via: feedback.via,
      };
      await this.col(userId).doc(entryId).update({ userFeedback: payload });
      return true;
    } catch (error) {
      logger.error("Error recording learning feedback:", error);
      return false;
    }
  }

  async getRecent(
    userId: string,
    limit: number = 20
  ): Promise<LearningLogEntry[]> {
    try {
      const snap = await this.col(userId)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();
      return snap.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<LearningLogEntry, "id">) }))
        .filter((e) => !e.deletedAt);
    } catch (error) {
      logger.error("Error fetching recent learning entries:", error);
      return [];
    }
  }

  // Soft delete del historial del usuario (comando "olvidar historial").
  // Hard delete después de N días lo cubre un job externo.
  async softDeleteAll(userId: string): Promise<boolean> {
    try {
      const snap = await this.col(userId).get();
      const batch = this.db.batch();
      const now = Timestamp.now();
      snap.docs.forEach((doc) => batch.update(doc.ref, { deletedAt: now }));
      await batch.commit();
      return true;
    } catch (error) {
      logger.error("Error soft-deleting learning log:", error);
      return false;
    }
  }
}
