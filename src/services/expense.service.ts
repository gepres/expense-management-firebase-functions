import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { ExpenseData } from "../types";

export class ExpenseService {
  private db: FirebaseFirestore.Firestore;

  constructor() {
    this.db = getFirestore();
  }

  private parseFecha(fecha: string): Date {
    if (fecha.length === 10) {
      const today = new Date();
      const p = fecha.split("-");
      return new Date(
        parseInt(p[0]),
        parseInt(p[1]) - 1,
        parseInt(p[2]),
        today.getHours(),
        today.getMinutes(),
        today.getSeconds()
      );
    }
    return new Date(fecha);
  }

  // Escribe el expense, su movement de gasto y actualiza accounts.saldo en
  // una sola transacción Firestore. Requiere accountId (ROADMAP § F.1).
  async saveExpense(
    expenseData: ExpenseData
  ): Promise<{
    success: boolean;
    expenseId?: string;
    saldoNuevo?: number;
    error?: string;
  }> {
    if (!expenseData.accountId) {
      const msg = "saveExpense: falta accountId (cuenta activa no resuelta)";
      logger.error(msg);
      return { success: false, error: msg };
    }

    try {
      const fechaTs = Timestamp.fromDate(this.parseFecha(expenseData.fecha));
      const now = Timestamp.now();
      const expenseRef = this.db.collection("expenses").doc();

      const expenseDoc: Record<string, unknown> = {
        userId: expenseData.userId,
        accountId: expenseData.accountId,
        monto: expenseData.monto,
        categoria: expenseData.categoria,
        descripcion: expenseData.descripcion,
        fecha: fechaTs,
        metodoPago: expenseData.metodoPago,
        moneda: expenseData.moneda,
        subcategoria: expenseData.subcategoria,
        recurrente: expenseData.recurrente,
        reimbursementStatus: expenseData.reimbursementStatus,
        // Defensivo: el flujo real siempre lo pasa (inferVoucherType);
        // el default evita escribir `undefined` si algún caller lo omite.
        voucherType: expenseData.voucherType ?? "boleta",
        // Marcador para el proyector de saldo del backend. Opción A intacta:
        // el bot NO toca saldo; el backend (dueño del ledger) debita el
        // sub-saldo correcto —bolsillo (`cashBalance`) si `metodoPago` es
        // efectivo, si no `bankBalance`— y pone esto en `true`. Marcador
        // POSITIVO: los expenses web/legacy NO tienen el campo, así el
        // sweep `balanceApplied == false` nunca los re-debita. Sin esto,
        // un gasto en efectivo por WhatsApp no descontaba del bolsillo
        // (ver docs/AUDIT.md "proyector de saldo").
        balanceApplied: false,
        createdAt: now,
        updatedAt: now,
      };

      const optional: Array<[string, unknown]> = [
        ["matchedTerm", expenseData.matchedTerm],
        ["matchedLevel", expenseData.matchedLevel],
        ["currencySource", expenseData.currencySource],
        ["dateSource", expenseData.dateSource],
        ["paymentMethodSource", expenseData.paymentMethodSource],
        ["needsClassification", expenseData.needsClassification],
        ["needsReview", expenseData.needsReview],
        ["messageSid", expenseData.messageSid],
      ];
      for (const [key, value] of optional) {
        if (value !== undefined) expenseDoc[key] = value;
      }

      // Saldo/ledger desacoplados: el bot ya NO mantiene saldo ni
      // `movements` (los maneja el web app/backend con su propio modelo).
      // Solo persiste el gasto contra la cuenta canónica.
      await expenseRef.set(expenseDoc);

      logger.info(`✅ Expense saved ${expenseRef.id}`, expenseDoc);

      return { success: true, expenseId: expenseRef.id };
    } catch (error) {
      logger.error("Error saving expense to Firestore:", error);
      return {
        success: false,
        error:
          error instanceof Error ?
            error.message :
            "Error desconocido al guardar el gasto",
      };
    }
  }

  async getExpensesByUserId(
    userId: string,
    limit: number = 10
  ): Promise<Array<ExpenseData & { id: string; createdAt: Date }>> {
    try {
      const snapshot = await this.db
        .collection("expenses")
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          userId: data.userId,
          accountId: data.accountId,
          monto: data.monto,
          categoria: data.categoria,
          descripcion: data.descripcion,
          fecha: data.fecha,
          metodoPago: data.metodoPago,
          moneda: data.moneda,
          subcategoria: data.subcategoria,
          recurrente: data.recurrente,
          reimbursementStatus: data.reimbursementStatus,
          voucherType: data.voucherType,
          createdAt: data.createdAt.toDate(),
        };
      });
    } catch (error) {
      logger.error("Error fetching expenses from Firestore:", error);
      return [];
    }
  }

  // Montos recientes del usuario para detección de monto atípico (§ G.1).
  async getRecentAmounts(
    userId: string,
    limit: number = 50
  ): Promise<number[]> {
    try {
      const snap = await this.db
        .collection("expenses")
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();
      return snap.docs
        .map((d) => Number(d.data().monto))
        .filter((n) => Number.isFinite(n) && n > 0);
    } catch (error) {
      logger.error("Error fetching recent amounts:", error);
      return [];
    }
  }

  // Idempotencia (§ C.1): ¿ya existe un expense para este MessageSid?
  async findByMessageSid(
    messageSid: string
  ): Promise<{ id: string } | null> {
    try {
      const snap = await this.db
        .collection("expenses")
        .where("messageSid", "==", messageSid)
        .limit(1)
        .get();
      if (snap.empty) return null;
      return { id: snap.docs[0].id };
    } catch (error) {
      logger.error("Error checking messageSid idempotency:", error);
      return null;
    }
  }

  // Gastos que requieren atención del usuario (§ C.6).
  async getPending(
    userId: string,
    limit: number = 20
  ): Promise<
    Array<{
      id: string;
      descripcion: string;
      monto: number;
      moneda: string;
      categoria: string;
      needsClassification?: boolean;
      needsReview?: boolean;
      amountFlagged?: boolean;
    }>
  > {
    try {
      const base = this.db.collection("expenses").where("userId", "==", userId);
      const [clsSnap, revSnap, amtSnap] = await Promise.all([
        base.where("needsClassification", "==", true).limit(limit).get(),
        base.where("needsReview", "==", true).limit(limit).get(),
        base.where("amountFlagged", "==", true).limit(limit).get(),
      ]);
      const byId = new Map<string, FirebaseFirestore.DocumentData>();
      [...clsSnap.docs, ...revSnap.docs, ...amtSnap.docs].forEach((d) => {
        if (!byId.has(d.id)) byId.set(d.id, { id: d.id, ...d.data() });
      });
      return Array.from(byId.values())
        .slice(0, limit)
        .map((d) => ({
          id: d.id,
          descripcion: d.descripcion,
          monto: d.monto,
          moneda: d.moneda,
          categoria: d.categoria,
          needsClassification: d.needsClassification,
          needsReview: d.needsReview,
          amountFlagged: d.amountFlagged,
        }));
    } catch (error) {
      logger.error("Error fetching pending expenses:", error);
      return [];
    }
  }

  async getById(
    expenseId: string
  ): Promise<{ id: string; userId: string; descripcion: string } | null> {
    try {
      const doc = await this.db.collection("expenses").doc(expenseId).get();
      if (!doc.exists) return null;
      const d = doc.data() as FirebaseFirestore.DocumentData;
      return { id: doc.id, userId: d.userId, descripcion: d.descripcion };
    } catch (error) {
      logger.error("Error fetching expense by id:", error);
      return null;
    }
  }

  // Último gasto del usuario (por createdAt) — para "borrar/corregir el
  // último" sin que el usuario tenga que copiar un ID.
  async getLastExpense(userId: string): Promise<{
    id: string;
    monto: number;
    moneda: string;
    descripcion: string;
    categoria: string;
  } | null> {
    try {
      const snap = await this.db
        .collection("expenses")
        .where("userId", "==", userId)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get();
      if (snap.empty) return null;
      const d = snap.docs[0];
      const data = d.data();
      return {
        id: d.id,
        monto: Number(data.monto) || 0,
        moneda: data.moneda,
        descripcion: data.descripcion,
        categoria: data.categoria,
      };
    } catch (error) {
      logger.error("Error fetching last expense:", error);
      return null;
    }
  }

  async deleteExpense(expenseId: string): Promise<boolean> {
    try {
      await this.db.collection("expenses").doc(expenseId).delete();
      return true;
    } catch (error) {
      logger.error("Error deleting expense:", error);
      return false;
    }
  }

  async updateAmount(expenseId: string, monto: number): Promise<boolean> {
    try {
      await this.db.collection("expenses").doc(expenseId).update({
        monto: monto,
        updatedAt: Timestamp.now(),
      });
      return true;
    } catch (error) {
      logger.error("Error updating expense amount:", error);
      return false;
    }
  }

  async updateClassification(
    expenseId: string,
    categoria: string,
    subcategoria: string | null
  ): Promise<boolean> {
    try {
      await this.db.collection("expenses").doc(expenseId).update({
        categoria: categoria,
        subcategoria: subcategoria,
        needsClassification: false,
        matchedLevel: "user_correction",
        updatedAt: Timestamp.now(),
      });
      return true;
    } catch (error) {
      logger.error("Error updating expense classification:", error);
      return false;
    }
  }

  async getExpenseSummary(userId: string, month?: string): Promise<{
    total: number;
    byCategory: Record<string, number>;
    count: number;
  }> {
    try {
      let query = this.db
        .collection("expenses")
        .where("userId", "==", userId);

      if (month) {
        const [y, m] = month.split("-").map((n) => parseInt(n, 10));
        const start = Timestamp.fromDate(new Date(y, m - 1, 1));
        const end = Timestamp.fromDate(new Date(y, m, 1));
        query = query
          .where("fecha", ">=", start)
          .where("fecha", "<", end);
      }

      const snapshot = await query.get();

      let total = 0;
      const byCategory: Record<string, number> = {};

      snapshot.forEach((doc) => {
        const data = doc.data();
        total += data.monto;
        byCategory[data.categoria] =
          (byCategory[data.categoria] || 0) + data.monto;
      });

      return {
        total,
        byCategory,
        count: snapshot.size,
      };
    } catch (error) {
      logger.error("Error calculating expense summary:", error);
      return {
        total: 0,
        byCategory: {},
        count: 0,
      };
    }
  }

  // Resumen (total + por categoría + count) en un rango [start, end) sobre
  // `fecha` (fecha efectiva del gasto). Para "cuanto gaste hoy/semana/mes".
  async getSummaryBetween(
    userId: string,
    start: Date,
    end: Date
  ): Promise<{
    total: number;
    byCategory: Record<string, number>;
    count: number;
  }> {
    try {
      const snapshot = await this.db
        .collection("expenses")
        .where("userId", "==", userId)
        .where("fecha", ">=", Timestamp.fromDate(start))
        .where("fecha", "<", Timestamp.fromDate(end))
        .get();

      let total = 0;
      const byCategory: Record<string, number> = {};
      snapshot.forEach((doc) => {
        const d = doc.data();
        const monto = Number(d.monto) || 0;
        total += monto;
        byCategory[d.categoria] = (byCategory[d.categoria] || 0) + monto;
      });
      return { total, byCategory, count: snapshot.size };
    } catch (error) {
      logger.error("Error summarizing expenses by range:", error);
      return { total: 0, byCategory: {}, count: 0 };
    }
  }

  // Gastos individuales en un rango [start, end), recientes primero.
  // Para "gastos de hoy" / "que gaste esta semana".
  async getExpensesBetween(
    userId: string,
    start: Date,
    end: Date,
    limit: number = 15
  ): Promise<
    Array<{
      monto: number;
      moneda: string;
      categoria: string;
      descripcion: string;
      fecha: Date;
    }>
  > {
    try {
      const snapshot = await this.db
        .collection("expenses")
        .where("userId", "==", userId)
        .where("fecha", ">=", Timestamp.fromDate(start))
        .where("fecha", "<", Timestamp.fromDate(end))
        .orderBy("fecha", "desc")
        .limit(limit)
        .get();
      return snapshot.docs.map((doc) => {
        const d = doc.data();
        const f: FirebaseFirestore.Timestamp | undefined = d.fecha;
        return {
          monto: Number(d.monto) || 0,
          moneda: d.moneda,
          categoria: d.categoria,
          descripcion: d.descripcion,
          fecha: f ? f.toDate() : new Date(0),
        };
      });
    } catch (error) {
      logger.error("Error fetching expenses by range:", error);
      return [];
    }
  }

  // Filas planas para export CSV (§ A.4). Filtro opcional por mes
  // ("YYYY-MM"). fecha en ISO. Límite alto para no truncar el export.
  async getForExport(
    userId: string,
    month?: string,
    limit: number = 5000
  ): Promise<ExportExpenseRow[]> {
    try {
      let query: FirebaseFirestore.Query = this.db
        .collection("expenses")
        .where("userId", "==", userId);

      if (month) {
        const [y, m] = month.split("-").map((n) => parseInt(n, 10));
        const start = Timestamp.fromDate(new Date(y, m - 1, 1));
        const end = Timestamp.fromDate(new Date(y, m, 1));
        query = query
          .where("fecha", ">=", start)
          .where("fecha", "<", end);
      }

      const snapshot = await query.limit(limit).get();
      return snapshot.docs.map((doc) => {
        const d = doc.data();
        const fecha: FirebaseFirestore.Timestamp | undefined = d.fecha;
        return {
          id: doc.id,
          fecha: fecha ? fecha.toDate().toISOString() : "",
          monto: d.monto,
          moneda: d.moneda,
          categoria: d.categoria,
          subcategoria: d.subcategoria ?? "",
          descripcion: d.descripcion,
          metodoPago: d.metodoPago,
          voucherType: d.voucherType,
          accountId: d.accountId ?? "",
        };
      });
    } catch (error) {
      logger.error("Error fetching expenses for export:", error);
      return [];
    }
  }
}

export interface ExportExpenseRow {
  id: string;
  fecha: string;
  monto: number;
  moneda: string;
  categoria: string;
  subcategoria: string;
  descripcion: string;
  metodoPago: string;
  voucherType: string;
  accountId: string;
}
