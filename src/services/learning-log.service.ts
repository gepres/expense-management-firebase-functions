import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  tokenizeForLearning,
  tokenOverlap,
  buildLearningLogDoc,
} from "@gastos/expense-ai";
import {
  LearningLogEntry,
  LearningLogEntryInput,
  LearningLogFeedback,
} from "../types";

// Tokenización/solape viven en `@gastos/expense-ai` (single source of
// truth con gastos-backend). Se re-exportan para no tocar a los
// importadores históricos (tests, etc.).
export { tokenizeForLearning, tokenOverlap };

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
      // Doc canónico (poda undefined + tokens) desde el paquete
      // compartido → byte-compatible con gastos-backend. `createdAt` lo
      // añade cada repo con su propio Timestamp.
      await docRef.set({
        ...buildLearningLogDoc(entry),
        createdAt: Timestamp.now(),
      });
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
  // Paginado + BulkWriter: un `db.batch()` único reventaba con >500
  // entradas (límite Firestore); BulkWriter auto-batchea a ≤500 y
  // reintenta. El hard-delete posterior lo hace `purgeSoftDeleted` (job
  // `purgeDeletedLearningLog`, rec. #4 docs/AUDIT.md).
  async softDeleteAll(userId: string): Promise<boolean> {
    try {
      const now = Timestamp.now();
      const writer = this.db.bulkWriter();
      const pageSize = 400;
      let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
      let total = 0;
      let page = await this.col(userId)
        .orderBy("__name__")
        .limit(pageSize)
        .get();
      while (!page.empty) {
        for (const doc of page.docs) {
          void writer.update(doc.ref, { deletedAt: now });
        }
        total += page.size;
        if (page.size < pageSize) break;
        last = page.docs[page.docs.length - 1];
        page = await this.col(userId)
          .orderBy("__name__")
          .startAfter(last)
          .limit(pageSize)
          .get();
      }
      await writer.close();
      logger.info(
        `learning_log soft-delete: ${total} entradas (user ${userId})`
      );
      return true;
    } catch (error) {
      logger.error("Error soft-deleting learning log:", error);
      return false;
    }
  }

  // Hard delete de entradas soft-deleted hace > `olderThan` (job
  // `purgeDeletedLearningLog`, rec. #4). collectionGroup + filtro/orden
  // por `deletedAt`: solo requiere el índice de campo único AUTOMÁTICO
  // (no compuesto → no toca firestore.indexes.json, §7). Tope `max` por
  // corrida; el resto se drena en corridas siguientes. Devuelve cuántas
  // borró.
  async purgeSoftDeleted(
    olderThan: Date,
    max: number = 5000
  ): Promise<number> {
    const cutoff = Timestamp.fromDate(olderThan);
    const writer = this.db.bulkWriter();
    const pageSize = 400;
    let deleted = 0;
    let last: FirebaseFirestore.QueryDocumentSnapshot | undefined;
    const base = (): FirebaseFirestore.Query =>
      this.db
        .collectionGroup("learning_log")
        .where("deletedAt", "<", cutoff)
        .orderBy("deletedAt")
        .limit(pageSize);
    let page = await base().get();
    while (!page.empty) {
      for (const doc of page.docs) {
        if (deleted >= max) break;
        void writer.delete(doc.ref);
        deleted++;
      }
      if (deleted >= max || page.size < pageSize) break;
      last = page.docs[page.docs.length - 1];
      page = await base().startAfter(last).get();
    }
    await writer.close();
    return deleted;
  }
}
