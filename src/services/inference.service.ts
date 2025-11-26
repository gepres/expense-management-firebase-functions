import { getFirestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions/v1";
import { Category, PaymentMethod } from "../types";

export class InferenceService {
  private db: FirebaseFirestore.Firestore;

  constructor() {
    this.db = getFirestore();
  }

  async inferCategory(userId: string, description: string): Promise<string> {
    try {
      const desc = description.toLowerCase();

      const categoriesSnapshot = await this.db
        .collection("users")
        .doc(userId)
        .collection("categories")
        .get();

      if (categoriesSnapshot.empty) {
        functions.logger.warn(`No categories found for user ${userId}`);
        return "otros";
      }

      const categories: Category[] = [];
      categoriesSnapshot.forEach((doc) => {
        categories.push({
          id: doc.id,
          ...doc.data(),
        } as Category);
      });

      for (const category of categories) {
        if (desc.includes(category.nombre.toLowerCase())) {
          functions.logger.info(`Category matched by name: ${category.id}`);
          return category.id;
        }

        if (category.subcategorias && category.subcategorias.length > 0) {
          for (const subcategory of category.subcategorias) {
            if (desc.includes(subcategory.nombre.toLowerCase())) {
              functions.logger.info(`Category matched by subcategory: ${category.id}`);
              return category.id;
            }

            if (subcategory.suggestions_ideas && subcategory.suggestions_ideas.length > 0) {
              for (const keyword of subcategory.suggestions_ideas) {
                if (desc.includes(keyword.toLowerCase())) {
                  functions.logger.info(`Category matched by keyword: ${category.id}`);
                  return category.id;
                }
              }
            }
          }
        }
      }

      functions.logger.info("No category match found, using first category or 'otros'");
      return categories.length > 0 ? categories[0].id : "otros";
    } catch (error) {
      functions.logger.error("Error inferring category:", error);
      return "otros";
    }
  }

  async inferSubCategory(
    userId: string,
    categoryId: string,
    description: string
  ): Promise<string | null> {
    try {
      const desc = description.toLowerCase();

      const categoryDoc = await this.db
        .collection("users")
        .doc(userId)
        .collection("categories")
        .doc(categoryId)
        .get();

      if (!categoryDoc.exists) {
        return null;
      }

      const category = categoryDoc.data() as Category;

      if (!category.subcategorias || category.subcategorias.length === 0) {
        return null;
      }

      for (const subcategory of category.subcategorias) {
        if (desc.includes(subcategory.nombre.toLowerCase())) {
          functions.logger.info(`Subcategory matched by name: ${subcategory.id}`);
          return subcategory.id;
        }

        if (subcategory.suggestions_ideas && subcategory.suggestions_ideas.length > 0) {
          for (const keyword of subcategory.suggestions_ideas) {
            if (desc.includes(keyword.toLowerCase())) {
              functions.logger.info(`Subcategory matched by keyword: ${subcategory.id}`);
              return subcategory.id;
            }
          }
        }
      }

      functions.logger.info("No subcategory match found, using first subcategory");
      return category.subcategorias.length > 0 ? category.subcategorias[0].id : null;
    } catch (error) {
      functions.logger.error("Error inferring subcategory:", error);
      return null;
    }
  }

  async inferPaymentMethod(userId: string, description: string): Promise<string> {
    try {
      const desc = description.toLowerCase();

      if (desc.includes("yape") || desc.includes("con yape")) {
        return "yape";
      }
      if (desc.includes("plin") || desc.includes("con plin")) {
        return "plin";
      }
      if (desc.includes("efectivo") || desc.includes("en efectivo") || desc.includes("con efectivo")) {
        return "efectivo";
      }
      if (desc.includes("transferencia")) {
        return "transferencia";
      }
      if (desc.includes("tarjeta")) {
        return "tarjeta";
      }

      const paymentMethodsSnapshot = await this.db
        .collection("users")
        .doc(userId)
        .collection("payment_methods")
        .get();

      if (paymentMethodsSnapshot.empty) {
        return "efectivo";
      }

      const paymentMethods: PaymentMethod[] = [];
      paymentMethodsSnapshot.forEach((doc) => {
        paymentMethods.push({
          id: doc.id,
          ...doc.data(),
        } as PaymentMethod);
      });

      for (const method of paymentMethods) {
        if (desc.includes(method.nombre.toLowerCase())) {
          functions.logger.info(`Payment method matched: ${method.id}`);
          return method.id;
        }
      }

      return paymentMethods.length > 0 ? paymentMethods[0].id : "efectivo";
    } catch (error) {
      functions.logger.error("Error inferring payment method:", error);
      return "efectivo";
    }
  }

  async getCategories(userId: string): Promise<Category[]> {
    try {
      const categoriesSnapshot = await this.db
        .collection("users")
        .doc(userId)
        .collection("categories")
        .get();

      const categories: Category[] = [];
      categoriesSnapshot.forEach((doc) => {
        categories.push({
          id: doc.id,
          ...doc.data(),
        } as Category);
      });

      return categories;
    } catch (error) {
      functions.logger.error("Error getting categories:", error);
      return [];
    }
  }

  async getPaymentMethods(userId: string): Promise<PaymentMethod[]> {
    try {
      const methodsSnapshot = await this.db
        .collection("users")
        .doc(userId)
        .collection("payment_methods")
        .get();

      const methods: PaymentMethod[] = [];
      methodsSnapshot.forEach((doc) => {
        methods.push({
          id: doc.id,
          ...doc.data(),
        } as PaymentMethod);
      });

      return methods;
    } catch (error) {
      functions.logger.error("Error getting payment methods:", error);
      return [];
    }
  }

  inferCurrency(description: string): string {
    try {
      const desc = description.toLowerCase();

      if (desc.includes("dólar") || desc.includes("dolar") || desc.includes("usd") || desc.includes("$")) {
        return "USD";
      }
      if (desc.includes("soles") || desc.includes("sol") || desc.includes("pen")) {
        return "PEN";
      }

      functions.logger.info("No currency match found, using default: PEN");
      return "PEN";
    } catch (error) {
      functions.logger.error("Error inferring currency:", error);
      return "PEN";
    }
  }

  inferVoucherType(description: string): string {
    try {
      const desc = description.toLowerCase();

      if (desc.includes("factura")) {
        return "factura";
      }
      if (desc.includes("recibo")) {
        return "recibo";
      }
      if (desc.includes("nota de venta") || desc.includes("nota venta")) {
        return "nota_venta";
      }

      functions.logger.info("No voucher type match found, using default: boleta");
      return "boleta";
    } catch (error) {
      functions.logger.error("Error inferring voucher type:", error);
      return "boleta";
    }
  }
}
