import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "firebase-functions/v1";
import { ExpenseData } from "../types";

export class ExpenseService {
  private db: FirebaseFirestore.Firestore;

  constructor() {
    this.db = getFirestore();
  }

  async saveExpense(
    phoneNumber: string,
    expenseData: ExpenseData
  ): Promise<{ success: boolean; expenseId?: string; error?: string }> {
    try {
      const expenseDoc = {
        phoneNumber,
        monto: expenseData.monto,
        categoria: expenseData.categoria,
        descripcion: expenseData.descripcion,
        fecha: expenseData.fecha,
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

  async getExpensesByPhone(
    phoneNumber: string,
    limit: number = 10
  ): Promise<Array<ExpenseData & { id: string; createdAt: Date }>> {
    try {
      const snapshot = await this.db
        .collection("expenses")
        .where("phoneNumber", "==", phoneNumber)
        .orderBy("createdAt", "desc")
        .limit(limit)
        .get();

      return snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          monto: data.amount,
          categoria: data.category,
          descripcion: data.description,
          fecha: data.date,
          createdAt: data.createdAt.toDate(),
        };
      });
    } catch (error) {
      functions.logger.error("Error fetching expenses from Firestore:", error);
      return [];
    }
  }

  async getExpenseSummary(phoneNumber: string, month?: string): Promise<{
    total: number;
    byCategory: Record<string, number>;
    count: number;
  }> {
    try {
      let query = this.db
        .collection("expenses")
        .where("phoneNumber", "==", phoneNumber);

      if (month) {
        const startDate = `${month}-01`;
        const endDate = `${month}-31`;
        query = query.where("date", ">=", startDate).where("date", "<=", endDate);
      }

      const snapshot = await query.get();

      let total = 0;
      const byCategory: Record<string, number> = {};

      snapshot.forEach((doc) => {
        const data = doc.data();
        total += data.amount;
        byCategory[data.category] = (byCategory[data.category] || 0) + data.amount;
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
