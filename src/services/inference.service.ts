// Adaptador delgado: el RANKING de clasificación vive en
// `@gastos/expense-ai` (single source of truth, compartido con
// gastos-backend). Acá solo se inyectan los accesos a Firestore
// (categorías, métodos, learning_log) y la llamada LLM acotada.
//
// La API pública (clase InferenceService + `phraseMatches`/
// `categoryIdForTerm`/`UNCLASSIFIED_CATEGORY`/`MIN_HISTORY_OVERLAP`)
// se mantiene IDÉNTICA para no tocar index.ts ni los tests.

import { getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  classifyExpense,
  resolvePaymentMethod as sharedResolvePaymentMethod,
  resolveCurrency as sharedResolveCurrency,
  inferVoucherType as sharedInferVoucherType,
} from "@gastos/expense-ai";
import type {
  ClassificationResult,
  ClassifyDeps,
  HistoryEntry,
  PaymentMethodResolution,
  CurrencyResolution,
} from "@gastos/expense-ai";
import { Category, PaymentMethod, LearningLogEntry } from "../types";
import { LearningLogService } from "./learning-log.service";
import { AnthropicService } from "./anthropic.service";
import { TtlCache } from "../utils/ttl-cache";

// Caché por instancia de la taxonomía del usuario (rec. #5 docs/AUDIT.md):
// `getCategories`/`getPaymentMethods` se llamaban en CADA mensaje releyendo
// la subcolección completa. TTL corto → consistencia eventual aceptable
// (un alta en la app tarda ≤ TTL en verse por WhatsApp).
const categoriesCache = new TtlCache<Category[]>();
const paymentMethodsCache = new TtlCache<PaymentMethod[]>();

// Re-export desde el paquete: index.ts importa `categoryIdForTerm`;
// los tests importan `phraseMatches`/`categoryIdForTerm`. El centinela
// y el umbral se reexportan por compatibilidad histórica.
export {
  phraseMatches,
  categoryIdForTerm,
  UNCLASSIFIED_CATEGORY,
  MIN_HISTORY_OVERLAP,
} from "@gastos/expense-ai";
export type { ClassificationResult } from "@gastos/expense-ai";

// learning_log de functions → HistoryEntry neutro del paquete.
function toHistoryEntry(e: LearningLogEntry): HistoryEntry {
  return {
    field: e.decision.field,
    value: e.decision.value,
    correctedValue: e.userFeedback?.correctedValue ?? null,
    source: e.decision.source,
    type: e.type,
    hasFeedback: !!e.userFeedback,
    tokens: e.tokens ?? [],
    normalizedInput: e.input.normalized,
    createdAtMs: e.createdAt.toMillis(),
  };
}

export class InferenceService {
  private db: FirebaseFirestore.Firestore;
  private learningLog: LearningLogService;

  constructor() {
    this.db = getFirestore();
    this.learningLog = new LearningLogService();
  }

  // Flujo ROADMAP § B.5 + § G.3 + § A.1 (C). El orden 1→6 vive en el
  // paquete; acá solo se inyectan categorías, historial y LLM.
  async classify(
    userId: string,
    description: string,
    llmCategoryHint?: string
  ): Promise<ClassificationResult> {
    const deps: ClassifyDeps = {
      getCategories: () => this.getCategories(userId),
      getHistory: async (normalized) => {
        const history = await this.learningLog.queryRelevant(
          userId,
          normalized,
          { limit: 20 }
        );
        return history.map(toHistoryEntry);
      },
      llmClassify: async (desc, candidates) => {
        try {
          return await new AnthropicService().classifyAgainstTaxonomy(
            desc,
            candidates,
            { userId }
          );
        } catch (error) {
          logger.error("LLM taxonomy classification failed:", error);
          return null;
        }
      },
    };
    return classifyExpense({ description, llmCategoryHint }, deps);
  }

  // Validación/resolución de método de pago (ROADMAP § B.3). El matching
  // vive en el paquete; acá solo se cargan los métodos del usuario.
  async resolvePaymentMethod(
    userId: string,
    description: string,
    explicitHint?: string
  ): Promise<PaymentMethodResolution> {
    const methods = await this.getPaymentMethods(userId);
    return sharedResolvePaymentMethod(description, methods, explicitHint);
  }

  async getCategories(userId: string): Promise<Category[]> {
    const cached = categoriesCache.get(userId);
    if (cached) return cached;
    try {
      const snap = await this.db
        .collection("users")
        .doc(userId)
        .collection("categories")
        .get();
      const categories: Category[] = [];
      snap.forEach((doc) => {
        categories.push({ id: doc.id, ...doc.data() } as Category);
      });
      // No cachear `[]`: distingue "sin categorías" de un fallo de lectura
      // y deja que el siguiente mensaje reintente.
      if (categories.length > 0) categoriesCache.set(userId, categories);
      return categories;
    } catch (error) {
      logger.error("Error getting categories:", error);
      return [];
    }
  }

  async getPaymentMethods(userId: string): Promise<PaymentMethod[]> {
    const cached = paymentMethodsCache.get(userId);
    if (cached) return cached;
    try {
      const snap = await this.db
        .collection("users")
        .doc(userId)
        .collection("payment_methods")
        .get();
      const methods: PaymentMethod[] = [];
      snap.forEach((doc) => {
        methods.push({ id: doc.id, ...doc.data() } as PaymentMethod);
      });
      if (methods.length > 0) paymentMethodsCache.set(userId, methods);
      return methods;
    } catch (error) {
      logger.error("Error getting payment methods:", error);
      return [];
    }
  }

  // Moneda heredada de la cuenta activa salvo override en texto (§ B.2).
  resolveCurrency(
    description: string,
    accountMoneda: string
  ): CurrencyResolution {
    return sharedResolveCurrency(description, accountMoneda);
  }

  inferVoucherType(description: string): string {
    return sharedInferVoucherType(description);
  }
}
