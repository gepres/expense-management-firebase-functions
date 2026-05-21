import Anthropic from "@anthropic-ai/sdk";
import {
  buildReceiptExtractionPrompt,
  buildVoiceExpensePrompt,
  parseReceipt,
  parseVoice,
  isExtractionError,
} from "@gastos/expense-ai";
import { AnthropicResponse, ExpenseData, ReceiptExtractionResult } from "../types";
import { modelParams } from "../config/models";
import { recordUsage, UsageContext } from "./usage.service";
import { withRetry, isTransientError, isLowBalanceError } from "../utils/retry";
import * as logger from "firebase-functions/logger";

// Fecha de hoy (Perú) para el contexto de fechas relativas del prompt.
function todayLimaISO(): string {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Lima",
  });
}

/** Forma mínima del `usage` que devuelve la API de mensajes. */
interface AnthropicUsageLike {
  input_tokens?: number;
  output_tokens?: number;
}

// Registra (best-effort) el consumo de una llamada. Por decisión de
// producto, todo lo del bot de WhatsApp es consumo de USUARIO (scope
// "user"); el call site provee el `userId`.
function track(
  model: string,
  usage: AnthropicUsageLike | undefined,
  usageCtx: Partial<UsageContext> | undefined,
  feature: string
): void {
  void recordUsage({
    provider: "anthropic",
    model,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    userId: usageCtx?.userId ?? null,
    scope: usageCtx?.scope ?? "user",
    feature: usageCtx?.feature ?? feature,
  });
}

// Cliente SDK compartido por instancia (rec. #5 docs/AUDIT.md). Lazy: la
// API key (secret) recién está en env en runtime.
let sharedAnthropic: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (sharedAnthropic) return sharedAnthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("Anthropic API key not configured");
  }
  sharedAnthropic = new Anthropic({ apiKey });
  return sharedAnthropic;
}

export class AnthropicService {
  private client: Anthropic;

  constructor() {
    this.client = getAnthropicClient();
  }

  /**
   * messages.create con reintento ante errores transitorios (429/5xx/red).
   * Rec. #2 docs/AUDIT.md. Al agotar reintentos relanza para que el
   * pipeline deje el item `pending` y lo recupere reprocessPendingQueue.
   * @param {Anthropic.MessageCreateParamsNonStreaming} params Parámetros.
   * @param {string} label Etiqueta para los logs de reintento.
   * @return {Promise<Anthropic.Message>} Respuesta del modelo.
   */
  private send(
    params: Anthropic.MessageCreateParamsNonStreaming,
    label: string
  ): Promise<Anthropic.Message> {
    return withRetry(() => this.client.messages.create(params), { label });
  }

  async extractReceiptData(
    base64Image: string,
    mimeType: string,
    usageCtx?: Partial<UsageContext>
  ): Promise<ReceiptExtractionResult | null> {
    try {
      // Prompt + parsing del paquete compartido @gastos/expense-ai
      // (single source of truth, mismo que gastos-backend web).
      const mp = modelParams("primary");
      const response = await this.send({
        // Comprobante (vision) → tier "primary". modelParams resuelve modelo
        // + thinking/effort desde env (vía @gastos/expense-ai).
        ...mp,
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
                data: base64Image,
              },
            },
            {
              type: "text",
              text: buildReceiptExtractionPrompt(),
            },
          ],
        }],
      }, "anthropic.extractReceiptData");

      track(mp.model, response.usage, usageCtx, "whatsapp_receipt_ocr");

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Unexpected response type from Anthropic");
      }
      logger.info("Anthropic image extraction response:", content.text.trim());

      const parsed = parseReceipt(content.text);
      if (!parsed) {
        logger.error("No se pudo parsear la respuesta del comprobante");
        return null;
      }
      if (isExtractionError(parsed)) {
        logger.warn("Could not extract receipt data:", parsed.error);
        return null;
      }

      // Canónico (ES) → ReceiptExtractionResult de este repo.
      return {
        monto: parsed.monto,
        comercio: parsed.comercio,
        descripcion: parsed.descripcion,
        fecha: parsed.hora ?
          `${parsed.fecha} ${parsed.hora}` :
          parsed.fecha,
        metodoPago: parsed.metodoPago.toLowerCase(),
        moneda: parsed.moneda,
        categoria: parsed.categoria,
        subcategoria: parsed.subcategoria,
      };
    } catch (error) {
      // Transitorio → propaga (el pipeline lo deja `pending` y reintenta).
      if (isTransientError(error)) throw error;
      // Saldo bajo → propaga: el caller responde con mensaje de admin y
      // marca el item `failed` (dispara la alerta whatsapp_queue_failed).
      if (isLowBalanceError(error)) throw error;
      logger.error("Error extracting receipt data with Anthropic:", error);
      if (error instanceof Error) {
        logger.error("Error details:", {
          message: error.message,
          stack: error.stack,
        });
      }
      return null;
    }
  }

  async parseExpenseMessage(
    message: string,
    usageCtx?: Partial<UsageContext>
  ): Promise<AnthropicResponse> {
    try {
      // Prompt + parsing del paquete compartido @gastos/expense-ai
      // (single source of truth, mismo flujo que voz/web en gastos-backend).
      const prompt = buildVoiceExpensePrompt(message, todayLimaISO());

      const mp = modelParams("primary");
      const response = await this.send({
        // Parse principal de texto → tier "primary".
        ...mp,
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: prompt,
        }],
      }, "anthropic.parseExpenseMessage");

      track(mp.model, response.usage, usageCtx, "whatsapp_expense_parse");

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Unexpected response type from Anthropic");
      }

      const rawResponse = content.text.trim();
      logger.info("Anthropic raw response:", rawResponse);

      const parsed = parseVoice(content.text);
      if (!parsed) {
        return {
          success: false,
          error: "Respuesta incompleta de Anthropic",
          rawResponse,
        };
      }
      if (isExtractionError(parsed)) {
        return {
          success: false,
          error: parsed.error,
          rawResponse,
        };
      }

      // Canónico (ES) → ExpenseData de este repo. metodoPago/fecha los
      // refina luego finalizeAndRegisterExpense (resolvePaymentMethod /
      // parseDateFromText); acá solo se asegura el contrato no-null.
      const expenseData: ExpenseData = {
        userId: "",
        monto: parsed.monto,
        categoria: parsed.categoria,
        descripcion: parsed.descripcion,
        fecha: parsed.fecha ?? todayLimaISO(),
        metodoPago: parsed.metodoPago ?? "",
        moneda: parsed.moneda,
        subcategoria: parsed.subcategoria,
        recurrente: false,
        reimbursementStatus: "pending",
        // voucherType NO se setea acá: lo resuelve inferVoucherType en
        // finalizeAndRegisterExpense (este valor se ignoraba — § A.1).
      };

      return {
        success: true,
        expenseData,
        rawResponse,
      };
    } catch (error) {
      if (isTransientError(error)) throw error;
      // Saldo bajo → propaga: ver nota en extractReceiptData.
      if (isLowBalanceError(error)) throw error;
      logger.error("Error parsing expense with Anthropic:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido al procesar el mensaje",
      };
    }
  }

  private extractJson(responseText: string): string {
    if (responseText.includes("```json")) {
      const m = responseText.match(/```json\s*([\s\S]*?)\s*```/);
      if (m) return m[1];
    } else if (responseText.includes("```")) {
      const m = responseText.match(/```\s*([\s\S]*?)\s*```/);
      if (m) return m[1];
    }
    return responseText;
  }

  // Fallback LLM para fechas relativas que el regex no resuelve
  // (ROADMAP § B.4 / § G.1). Devuelve YYYY-MM-DD o null.
  async parseRelativeDate(
    text: string,
    referenceDateISO: string,
    usageCtx?: Partial<UsageContext>
  ): Promise<string | null> {
    try {
      const prompt =
        "Eres un parser de fechas en español (Perú). " +
        `La fecha de referencia (hoy) es ${referenceDateISO}.\n` +
        `Texto: "${text}"\n\n` +
        "Si el texto menciona una fecha relativa o explícita para el " +
        "gasto (ej. \"hace una semana\", \"el lunes pasado\", " +
        "\"el viernes\", \"antes de ayer\"), responde SOLO con JSON " +
        "{\"fecha\": \"YYYY-MM-DD\"}. Si no hay ninguna referencia " +
        "temporal, responde {\"fecha\": null}. SOLO el JSON.";

      // Helper acotado (fallback de regex, devuelve un valor de lista) →
      // tier "helper". modelParams omite output_config.effort si el modelo
      // resuelto no lo soporta (p.ej. Haiku → 400). Ver src/config/models.ts.
      const mp = modelParams("helper");
      const response = await this.send(
        { ...mp, max_tokens: 128, messages: [{ role: "user", content: prompt }] },
        "anthropic.parseRelativeDate"
      );

      track(mp.model, response.usage, usageCtx, "whatsapp_date_parse");

      const content = response.content[0];
      if (content.type !== "text") return null;
      const parsed = JSON.parse(this.extractJson(content.text.trim()));
      if (!parsed.fecha || typeof parsed.fecha !== "string") return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.fecha)) return null;
      return parsed.fecha;
    } catch (error) {
      logger.error("Error parsing relative date with LLM:", error);
      return null;
    }
  }

  // Clasifica una descripción contra las categorías del usuario
  // (ROADMAP § A.1 opción C). Solo se invoca como fallback (taxonomía
  // exacta + historial fallaron). Devuelve un candidato EXACTO de la
  // lista o null si ninguno corresponde con confianza.
  async classifyAgainstTaxonomy(
    description: string,
    candidates: string[],
    usageCtx?: Partial<UsageContext>
  ): Promise<string | null> {
    if (candidates.length === 0) return null;
    try {
      const prompt =
        "Clasifica el gasto en UNA de las categorías del usuario.\n" +
        `Descripción: "${description}"\n` +
        `Categorías: ${JSON.stringify(candidates)}\n\n` +
        "Responde SOLO con JSON {\"categoria\": \"<categoría EXACTA de " +
        "la lista>\"} o {\"categoria\": null} si ninguna corresponde con " +
        "confianza razonable. SOLO el JSON.";

      // Helper acotado → tier "helper".
      const mp = modelParams("helper");
      const response = await this.send(
        { ...mp, max_tokens: 128, messages: [{ role: "user", content: prompt }] },
        "anthropic.classifyAgainstTaxonomy"
      );

      track(mp.model, response.usage, usageCtx, "whatsapp_category_classify");

      const content = response.content[0];
      if (content.type !== "text") return null;
      const parsed = JSON.parse(this.extractJson(content.text.trim()));
      if (!parsed.categoria || typeof parsed.categoria !== "string") {
        return null;
      }
      return candidates.includes(parsed.categoria) ? parsed.categoria : null;
    } catch (error) {
      logger.error("Error classifying against taxonomy:", error);
      return null;
    }
  }

  // Desambigua un método de pago contra los conocidos del usuario
  // (ROADMAP § G.1). Devuelve un candidato exacto de la lista o null.
  async disambiguatePaymentMethod(
    hint: string,
    candidates: string[],
    usageCtx?: Partial<UsageContext>
  ): Promise<string | null> {
    if (candidates.length === 0) return null;
    try {
      const prompt =
        "Mapea el método de pago mencionado al candidato más probable.\n" +
        `Mencionado: "${hint}"\n` +
        `Candidatos: ${JSON.stringify(candidates)}\n\n` +
        "Responde SOLO con JSON {\"match\": \"<candidato exacto de la " +
        "lista>\"} o {\"match\": null} si ninguno corresponde con " +
        "confianza. SOLO el JSON.";

      // Helper acotado → tier "helper".
      const mp = modelParams("helper");
      const response = await this.send(
        { ...mp, max_tokens: 128, messages: [{ role: "user", content: prompt }] },
        "anthropic.disambiguatePaymentMethod"
      );

      track(
        mp.model,
        response.usage,
        usageCtx,
        "whatsapp_payment_disambiguation"
      );

      const content = response.content[0];
      if (content.type !== "text") return null;
      const parsed = JSON.parse(this.extractJson(content.text.trim()));
      if (!parsed.match || typeof parsed.match !== "string") return null;
      return candidates.includes(parsed.match) ? parsed.match : null;
    } catch (error) {
      logger.error("Error disambiguating payment method:", error);
      return null;
    }
  }
}
