import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  Category,
  PaymentMethod,
  MatchedLevel,
  PaymentMethodSource,
} from "../types";
import { MessageParser } from "../utils/message-parser";
import {
  LearningLogService,
  tokenizeForLearning,
  tokenOverlap,
} from "./learning-log.service";
import { AnthropicService } from "./anthropic.service";

export const UNCLASSIFIED_CATEGORY = "sin_clasificar";

// Solape mínimo de tokens para reusar una decisión del historial (paso 4).
// Evita falsos positivos por 1 token común entre descripciones largas;
// una corrección corta contenida en la nueva descripción da overlap 1.
export const MIN_HISTORY_OVERLAP = 0.5;

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
export function phraseMatches(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(haystack);
}

// Mapea un término (hint libre del LLM o candidato elegido) a una
// categoría del usuario por `id` exacto o `nombre` (palabra completa,
// en cualquier dirección). null si no corresponde. ROADMAP § A.1 (C).
export function categoryIdForTerm(
  term: string,
  categories: Category[]
): string | null {
  const norm = MessageParser.normalizeForMatching(term);
  if (!norm) return null;
  for (const cat of categories) {
    if (cat.id && MessageParser.normalizeForMatching(cat.id) === norm) {
      return cat.id;
    }
    const nameNorm = MessageParser.normalizeForMatching(cat.nombre || "");
    if (
      nameNorm &&
      (nameNorm === norm ||
        phraseMatches(norm, nameNorm) ||
        phraseMatches(nameNorm, norm))
    ) {
      return cat.id;
    }
  }
  return null;
}

export class InferenceService {
  private db: FirebaseFirestore.Firestore;
  private learningLog: LearningLogService;

  constructor() {
    this.db = getFirestore();
    this.learningLog = new LearningLogService();
  }

  // Flujo de clasificación ROADMAP § B.5 + § G.3 + § A.1 (C):
  //   1. suggestions_ideas → subcategoría dueña → categoría dueña
  //   2. nombre de subcategoría → categoría dueña
  //   3. nombre de categoría → subcategoría null
  //   4. historial del usuario (learning_log), por similitud de tokens
  //   5. LLM acotado a la taxonomía (reusa hint libre; llamada solo en miss)
  //   6. sin_clasificar (needsClassification)
  async classify(
    userId: string,
    description: string,
    llmCategoryHint?: string
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

    // 4. historial del usuario: correcciones explícitas (`user_correction`)
    // o clasificaciones previas reales. Nunca reusar el centinela
    // `sin_clasificar` (no se "aprende" a quedarse sin clasificar).
    // Se elige por similitud (solape de tokens ≥ MIN_HISTORY_OVERLAP),
    // priorizando correcciones del usuario, no la primera por recencia.
    const history = await this.learningLog.queryRelevant(userId, norm, {
      limit: 20,
    });
    const qTokens = tokenizeForLearning(norm);
    const best = history
      .filter((e) => {
        if (e.decision.field !== "categoria") return false;
        const value = e.userFeedback?.correctedValue ?? e.decision.value;
        return (
          typeof value === "string" &&
          value !== "" &&
          value !== UNCLASSIFIED_CATEGORY
        );
      })
      .map((e) => ({
        e,
        isCorrection:
          e.type === "user_correction" ||
          e.decision.source === "user_correction" ||
          !!e.userFeedback,
        score: tokenOverlap(qTokens, e.tokens ?? []),
      }))
      .filter((c) => c.score >= MIN_HISTORY_OVERLAP)
      .sort((a, b) => {
        if (a.isCorrection !== b.isCorrection) return a.isCorrection ? -1 : 1;
        if (b.score !== a.score) return b.score - a.score;
        return b.e.createdAt.toMillis() - a.e.createdAt.toMillis();
      })[0]?.e;
    if (best) {
      const corrected = best.userFeedback?.correctedValue;
      const categoria = String(corrected ?? best.decision.value);
      return {
        categoria,
        subcategoria: null,
        matchedTerm: best.input.normalized,
        matchedLevel: "history",
        needsClassification: false,
      };
    }

    // 5. LLM acotado a la taxonomía del usuario (ROADMAP § A.1, opción C).
    // Solo si 1–4 fallaron. 5a: reusar el hint libre que el LLM ya
    // devolvió (canal imagen/audio/fallback) — costo cero. 5b: si no hay
    // hint o no mapea (camino regex), 1 llamada acotada a las categorías.
    if (categories.length > 0) {
      if (llmCategoryHint) {
        const mapped = categoryIdForTerm(llmCategoryHint, categories);
        if (mapped) {
          return {
            categoria: mapped,
            subcategoria: null,
            matchedTerm: llmCategoryHint,
            matchedLevel: "llm",
            needsClassification: false,
          };
        }
      }
      const candidates = categories
        .map((c) => c.nombre)
        .filter((n): n is string => !!n);
      if (candidates.length > 0) {
        try {
          const picked = await new AnthropicService().classifyAgainstTaxonomy(
            description,
            candidates,
            { userId }
          );
          const mapped = picked ?
            categoryIdForTerm(picked, categories) :
            null;
          if (mapped) {
            return {
              categoria: mapped,
              subcategoria: null,
              matchedTerm: picked,
              matchedLevel: "llm",
              needsClassification: false,
            };
          }
        } catch (error) {
          logger.error("LLM taxonomy classification failed:", error);
        }
      }
    }

    // 6. sin clasificar
    return {
      categoria: UNCLASSIFIED_CATEGORY,
      subcategoria: null,
      matchedTerm: null,
      matchedLevel: "default",
      needsClassification: true,
    };
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
      logger.error("Error getting categories:", error);
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
      logger.error("Error getting payment methods:", error);
      return [];
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

      logger.info("No voucher type match found, using default: boleta");
      return "boleta";
    } catch (error) {
      logger.error("Error inferring voucher type:", error);
      return "boleta";
    }
  }
}
