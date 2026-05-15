import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions/v1";
import { ExpenseData } from "../types";
import { MovementService } from "./movement.service";

export class ExpenseService {
  private db: FirebaseFirestore.Firestore;
  private movementService: MovementService;

  constructor() {
    this.db = getFirestore();
    this.movementService = new MovementService();
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
      functions.logger.error(msg);
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
        voucherType: expenseData.voucherType,
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

      const saldoNuevo = await this.db.runTransaction(async (tx) => {
        const movResult = await this.movementService.writeMovement(
          expenseData.userId,
          {
            accountId: expenseData.accountId as string,
            tipo: "gasto",
            monto: expenseData.monto,
            expenseId: expenseRef.id,
            descripcion: expenseData.descripcion,
            fecha: fechaTs,
          },
          { tx }
        );
        tx.set(expenseRef, expenseDoc);
        return movResult.saldoNuevo;
      });

      functions.logger.info(
        `✅ Expense saved ${expenseRef.id} (saldo → ${saldoNuevo})`,
        expenseDoc
      );

      return { success: true, expenseId: expenseRef.id, saldoNuevo };
    } catch (error) {
      functions.logger.error("Error saving expense to Firestore:", error);
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
      functions.logger.error("Error fetching expenses from Firestore:", error);
      return [];
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
      functions.logger.error("Error calculating expense summary:", error);
      return {
        total: 0,
        byCategory: {},
        count: 0,
      };
    }
  }
}
