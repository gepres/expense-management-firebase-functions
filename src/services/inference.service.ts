import { getFirestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions/v1";
import {
  Category,
  PaymentMethod,
  MatchedLevel,
  PaymentMethodSource,
} from "../types";
import { MessageParser } from "../utils/message-parser";
import { LearningLogService } from "./learning-log.service";

export const UNCLASSIFIED_CATEGORY = "sin_clasificar";

export interface ClassificationResult {
  categoria: string;
  subcategoria: string | null;
  matchedTerm: string | null;
  matchedLevel: MatchedLevel;
  needsClassification: boolean;
}

// ¿`needle` aparece como palabra/frase completa dentro de `haystack`?
// Ambos ya normalizados (lowercase, sin diacríticos, espacios colapsados).
// Evita falsos positivos de substring (ej. "ropa" en "europa").
function phraseMatches(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(haystack);
}

export class InferenceService {
  private db: FirebaseFirestore.Firestore;
  private learningLog: LearningLogService;

  constructor() {
    this.db = getFirestore();
    this.learningLog = new LearningLogService();
  }

  // Flujo de clasificación ROADMAP § B.5 + § G.3:
  //   1. suggestions_ideas → subcategoría dueña → categoría dueña
  //   2. nombre de subcategoría → categoría dueña
  //   3. nombre de categoría → subcategoría null
  //   4. historial del usuario (learning_log)
  //   5. sin_clasificar (needsClassification)
  async classify(
    userId: string,
    description: string
  ): Promise<ClassificationResult> {
    const norm = MessageParser.normalizeForMatching(description);
    const categories = await this.getCategories(userId);

    // 1. suggestions_ideas
    for (const cat of categories) {
      for (const sub of cat.subcategorias || []) {
        for (const idea of sub.suggestions_ideas || []) {
          const ideaNorm = MessageParser.normalizeForMatching(idea);
          if (phraseMatches(norm, ideaNorm)) {
            return {
              categoria: cat.id,
              subcategoria: sub.id,
              matchedTerm: idea,
              matchedLevel: "suggestion",
              needsClassification: false,
            };
          }
        }
      }
    }

    // 2. nombre de subcategoría
    for (const cat of categories) {
      for (const sub of cat.subcategorias || []) {
        const subNorm = MessageParser.normalizeForMatching(sub.nombre);
        if (phraseMatches(norm, subNorm)) {
          return {
            categoria: cat.id,
            subcategoria: sub.id,
            matchedTerm: sub.nombre,
            matchedLevel: "subcategory",
            needsClassification: false,
          };
        }
      }
    }

    // 3. nombre de categoría (subcategoría queda null por decisión § E)
    for (const cat of categories) {
      const catNorm = MessageParser.normalizeForMatching(cat.nombre);
      if (phraseMatches(norm, catNorm)) {
        return {
          categoria: cat.id,
          subcategoria: null,
          matchedTerm: cat.nombre,
          matchedLevel: "category",
          needsClassification: false,
        };
      }
    }

    // 4. historial del usuario
    const history = await this.learningLog.queryRelevant(userId, norm, {
      type: "classification",
      limit: 10,
    });
    const fromHistory = history.find(
      (e) => e.decision.field === "categoria" && e.decision.value
    );
    if (fromHistory) {
      const corrected = fromHistory.userFeedback?.correctedValue;
      const categoria = String(corrected ?? fromHistory.decision.value);
      return {
        categoria,
        subcategoria: null,
        matchedTerm: fromHistory.input.normalized,
        matchedLevel: "history",
        needsClassification: false,
      };
    }

    // 5. sin clasificar
    return {
      categoria: UNCLASSIFIED_CATEGORY,
      subcategoria: null,
      matchedTerm: null,
      matchedLevel: "default",
      needsClassification: true,
    };
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

  // Validación/resolución de método de pago (ROADMAP § B.3).
  //  - Token explícito en texto (default conocido o método del usuario) → ok.
  //  - explicitHint (imagen/Anthropic) que no mapea a nada → "otro" + review.
  //  - Sin señal alguna → "efectivo" fallback, sin review (gasto sin método
  //    indicado no es un error, solo no especificado).
  async resolvePaymentMethod(
    userId: string,
    description: string,
    explicitHint?: string
  ): Promise<{
    metodoPago: string;
    source: PaymentMethodSource;
    needsReview: boolean;
  }> {
    const norm = MessageParser.normalizeForMatching(description);
    const defaults = ["yape", "plin", "efectivo", "transferencia", "tarjeta"];

    for (const d of defaults) {
      if (phraseMatches(norm, d)) {
        return { metodoPago: d, source: "text", needsReview: false };
      }
    }

    const methods = await this.getPaymentMethods(userId);
    for (const m of methods) {
      const mNorm = MessageParser.normalizeForMatching(m.nombre);
      if (phraseMatches(norm, mNorm)) {
        return { metodoPago: m.id, source: "text", needsReview: false };
      }
    }

    if (explicitHint && explicitHint.trim()) {
      const hint = MessageParser.normalizeForMatching(explicitHint);
      for (const d of defaults) {
        if (phraseMatches(hint, d) || hint === d) {
          return { metodoPago: d, source: "inferred", needsReview: false };
        }
      }
      for (const m of methods) {
        const mNorm = MessageParser.normalizeForMatching(m.nombre);
        if (phraseMatches(hint, mNorm) || hint === mNorm) {
          return { metodoPago: m.id, source: "inferred", needsReview: false };
        }
      }
      return { metodoPago: "otro", source: "fallback", needsReview: true };
    }

    return { metodoPago: "efectivo", source: "fallback", needsReview: false };
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

  // Moneda heredada de la cuenta activa salvo override explícito en el
  // texto del usuario (ROADMAP § B.2).
  resolveCurrency(
    description: string,
    accountMoneda: string
  ): { moneda: string; source: "text" | "account" } {
    const desc = description.toLowerCase();
    if (
      desc.includes("dólar") ||
      desc.includes("dolar") ||
      desc.includes("usd") ||
      desc.includes("$")
    ) {
      return { moneda: "USD", source: "text" };
    }
    if (
      desc.includes("soles") ||
      desc.includes("sol") ||
      desc.includes("pen")
    ) {
      return { moneda: "PEN", source: "text" };
    }
    return { moneda: accountMoneda, source: "account" };
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
