import Anthropic from "@anthropic-ai/sdk";
import { AnthropicResponse, ExpenseData, ReceiptExtractionResult } from "../types";
import { modelParams } from "../config/models";
import * as logger from "firebase-functions/logger";

export class AnthropicService {
  private client: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("Anthropic API key not configured");
    }
    this.client = new Anthropic({ apiKey });
  }

  async extractReceiptData(
    base64Image: string,
    mimeType: string
  ): Promise<ReceiptExtractionResult | null> {
    try {
      const prompt = "Analiza esta imagen de un comprobante, recibo o " +
        "captura de pago (Yape, Plin, transferencia, etc.) " +
        "y extrae la siguiente información:\n\n" +
        "Debes responder ÚNICAMENTE con un objeto JSON en el siguiente formato:\n" +
        "{\n" +
        "  \"monto\": número (solo el valor numérico, sin símbolos de moneda ni comas),\n" +
        "  \"comercio\": \"nombre del comercio o destinatario del pago\",\n" +
        "  \"descripcion\": \"descripción breve del producto/servicio o concepto del pago\",\n" +
        "  \"fecha\": \"fecha y hora en formato YYYY-MM-DD HH:MM:SS " +
        "(usa la fecha y hora de hoy si no se menciona)\",\n" +
        "  \"metodoPago\": \"método de pago detectado " +
        "(yape, plin, tarjeta, transferencia, efectivo)\",\n" +
        "  \"moneda\": \"moneda (PEN, USD, EUR, etc.)\",\n" +
        "  \"categoria\": \"categoría inferida " +
        "(comida, transporte, salud, entretenimiento, servicios, compras, otros)\",\n" +
        "  \"subcategoria\": \"subcategoría más específica si es posible inferir, o null\"\n" +
        "}\n\n" +
        "Si la imagen NO es un comprobante válido o no puedes extraer la información, " +
        "responde con:\n" +
        "{\n" +
        "  \"error\": \"No se pudo extraer información del comprobante\"\n" +
        "}\n\n" +
        "INSTRUCCIONES ESPECÍFICAS:\n" +
        "- CAPTURAS DE YAPE/PLIN: Busca el monto enviado/recibido (ej: 'S/ 25.50'), " +
        "el nombre del destinatario, y la fecha de la transacción\n" +
        "- RECIBOS/BOLETAS FÍSICAS: Extrae el nombre del comercio, monto total, " +
        "y fecha de emisión\n" +
        "- FACTURAS: Similar a recibos, extrae RUC si está visible\n" +
        "- Si ves el logo o interfaz de Yape, el metodoPago debe ser 'yape'\n" +
        "- Si ves el logo o interfaz de Plin, el metodoPago debe ser 'plin'\n" +
        "- Infiere la categoría basándote en el nombre del comercio o descripción del servicio\n" +
        "- Para el monto, solo devuelve el número sin símbolos: '25.50' no 'S/ 25.50'\n" +
        "- NO incluyas texto adicional fuera del JSON, SOLO el objeto JSON";

      const response = await this.client.messages.create({
        // Comprobante (vision) → tier "primary". modelParams resuelve modelo
        // + thinking/effort desde env (src/config/models.ts).
        ...modelParams("primary"),
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
              text: prompt,
            },
          ],
        }],
      });

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Unexpected response type from Anthropic");
      }

      const responseText = content.text.trim();
      logger.info("Anthropic image extraction response:", responseText);

      let jsonText = responseText;
      if (responseText.includes("```json")) {
        const match = responseText.match(/```json\s*([\s\S]*?)\s*```/);
        if (match) {
          jsonText = match[1];
        }
      } else if (responseText.includes("```")) {
        const match = responseText.match(/```\s*([\s\S]*?)\s*```/);
        if (match) {
          jsonText = match[1];
        }
      }

      const parsed = JSON.parse(jsonText);

      if (parsed.error) {
        logger.warn("Could not extract receipt data:", parsed.error);
        return null;
      }

      // Validate required fields
      if (!parsed.monto) {
        logger.error("Missing required field 'monto' in parsed data:", parsed);
        return null;
      }

      return {
        monto: Number(parsed.monto),
        comercio: parsed.comercio || "",
        descripcion: parsed.descripcion || parsed.comercio || "Gasto detectado",
        fecha: parsed.fecha || new Date().toISOString().split("T")[0],
        metodoPago: parsed.metodoPago?.toLowerCase() || "efectivo",
        moneda: parsed.moneda || "PEN",
        categoria: parsed.categoria || "otros",
        subcategoria: parsed.subcategoria || null,
      };
    } catch (error) {
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

  async parseExpenseMessage(message: string): Promise<AnthropicResponse> {
    try {
      const prompt = `Analiza el siguiente mensaje de WhatsApp y extrae información de un gasto.

Mensaje: "${message}"

Debes responder ÚNICAMENTE con un objeto JSON en el siguiente formato:
{
  "monto": número (solo el valor numérico, sin símbolos),
  "categoria": "categoría del gasto (comida, transporte, entretenimiento, salud, hogar, servicios, otros)",
  "descripcion": "descripción breve del gasto",
  "fecha": "fecha y hora en formato YYYY-MM-DD HH:MM:SS (usa la fecha y hora de hoy si no se menciona)",
  "moneda": "moneda (PEN(soles), USD(dolares))",
  "metodoPago": "metodo de pago (yape, plin, efectivo, transferencia, etc.)",
}

Si el mensaje NO contiene información de un gasto, responde con:
{
  "error": "No se pudo identificar información de gasto en el mensaje"
}

Ejemplos:
- "Gasté 25 soles en almuerzo" → {"monto": 25, "categoria": "comida", "descripcion": "almuerzo", "fecha": "2025-11-25"}
- "50 en taxi en efectivo" → {"monto": 50, "categoria": "transporte", "descripcion": "taxi", "fecha": "2025-11-25"}
- "Compré medicina por 80" → {"monto": 80, "categoria": "salud", "descripcion": "medicina", "fecha": "2025-11-25"}

NO incluyas texto adicional, SOLO el objeto JSON.`;

      const response = await this.client.messages.create({
        // Parse principal de texto → tier "primary".
        ...modelParams("primary"),
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: prompt,
        }],
      });

      const content = response.content[0];
      if (content.type !== "text") {
        throw new Error("Unexpected response type from Anthropic");
      }

      const responseText = content.text.trim();
      logger.info("Anthropic raw response:", responseText);

      let jsonText = responseText;
      if (responseText.includes("```json")) {
        const match = responseText.match(/```json\s*([\s\S]*?)\s*```/);
        if (match) {
          jsonText = match[1];
        }
      } else if (responseText.includes("```")) {
        const match = responseText.match(/```\s*([\s\S]*?)\s*```/);
        if (match) {
          jsonText = match[1];
        }
      }

      const parsed = JSON.parse(jsonText);

      if (parsed.error) {
        return {
          success: false,
          error: parsed.error,
          rawResponse: responseText,
        };
      }

      if (!parsed.monto || !parsed.categoria || !parsed.descripcion) {
        return {
          success: false,
          error: "Respuesta incompleta de Anthropic",
          rawResponse: responseText,
        };
      }

      const expenseData: ExpenseData = {
        userId: "",
        monto: Number(parsed.monto),
        categoria: parsed.categoria,
        descripcion: parsed.descripcion,
        fecha: parsed.fecha || new Date().toISOString(),
        metodoPago: parsed.metodoPago,
        moneda: parsed.moneda,
        subcategoria: null,
        recurrente: false,
        reimbursementStatus: "pending",
        // voucherType NO se setea acá: lo resuelve inferVoucherType en
        // finalizeAndRegisterExpense (este valor se ignoraba — § A.1).
      };

      return {
        success: true,
        expenseData,
        rawResponse: responseText,
      };
    } catch (error) {
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
    referenceDateISO: string
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
      const response = await this.client.messages.create({
        ...modelParams("helper"),
        max_tokens: 128,
        messages: [{ role: "user", content: prompt }],
      });

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
    candidates: string[]
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
      const response = await this.client.messages.create({
        ...modelParams("helper"),
        max_tokens: 128,
        messages: [{ role: "user", content: prompt }],
      });

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
    candidates: string[]
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
      const response = await this.client.messages.create({
        ...modelParams("helper"),
        max_tokens: 128,
        messages: [{ role: "user", content: prompt }],
      });

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
