import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions/v1";
import { ExpenseData } from "../types";

export class ExpenseService {
  private db: FirebaseFirestore.Firestore;

  constructor() {
    this.db = getFirestore();
  }

  async saveExpense(
    expenseData: ExpenseData
  ): Promise<{ success: boolean; expenseId?: string; error?: string }> {
    try {
      // Parse fecha - if it's just a date (YYYY-MM-DD), use current time
      let fechaDate: Date;
      if (expenseData.fecha.length === 10) {
        // Format: YYYY-MM-DD, add current time
        const today = new Date();
        const dateParts = expenseData.fecha.split("-");
        fechaDate = new Date(
          parseInt(dateParts[0]),
          parseInt(dateParts[1]) - 1,
          parseInt(dateParts[2]),
          today.getHours(),
          today.getMinutes(),
          today.getSeconds()
        );
      } else {
        // It's a full date-time string
        fechaDate = new Date(expenseData.fecha);
      }

      const expenseDoc = {
        userId: expenseData.userId,
        monto: expenseData.monto,
        categoria: expenseData.categoria,
        descripcion: expenseData.descripcion,
        fecha: Timestamp.fromDate(fechaDate),
        metodoPago: expenseData.metodoPago,
        moneda: expenseData.moneda,
        subcategoria: expenseData.subcategoria,
        recurrente: expenseData.recurrente,
        reimbursementStatus: expenseData.reimbursementStatus,
        voucherType: expenseData.voucherType,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      };

      const docRef = await this.db.collection("expenses").add(expenseDoc);

      functions.logger.info(`Expense saved successfully. ID: ${docRef.id}`, expenseDoc);

      return {
        success: true,
        expenseId: docRef.id,
      };
    } catch (error) {
      functions.logger.error("Error saving expense to Firestore:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido al guardar el gasto",
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
        const startDate = `${month}-01`;
        const endDate = `${month}-31`;
        query = query.where("fecha", ">=", startDate).where("fecha", "<=", endDate);
      }

      const snapshot = await query.get();

      let total = 0;
      const byCategory: Record<string, number> = {};

      snapshot.forEach((doc) => {
        const data = doc.data();
        total += data.monto;
        byCategory[data.categoria] = (byCategory[data.categoria] || 0) + data.monto;
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
