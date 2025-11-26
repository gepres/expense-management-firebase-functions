import Anthropic from "@anthropic-ai/sdk";
import { AnthropicResponse, ExpenseData, ReceiptExtractionResult } from "../types";
import * as functions from "firebase-functions/v1";

export class AnthropicService {
  private client: Anthropic;

  constructor() {
    const apiKey = functions.config().anthropic?.api_key || process.env.ANTHROPIC_API_KEY;
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
      const prompt = "Analiza esta imagen de un comprobante, recibo o captura de pago (Yape, Plin, etc.) " +
        "y extrae la siguiente información:\n\n" +
        "Debes responder ÚNICAMENTE con un objeto JSON en el siguiente formato:\n" +
        "{\n" +
        "  \"monto\": número (solo el valor numérico, sin símbolos),\n" +
        "  \"comercio\": \"nombre del comercio o destinatario\",\n" +
        "  \"descripcion\": \"descripción breve del producto/servicio\",\n" +
        "  \"fecha\": \"fecha en formato YYYY-MM-DD\",\n" +
        "  \"metodoPago\": \"método de pago (efectivo, yape, plin, tarjeta, transferencia)\",\n" +
        "  \"moneda\": \"moneda (PEN, USD, etc.)\",\n" +
        "  \"categoria\": \"categoría inferida (comida, transporte, salud, etc.)\",\n" +
        "  \"subcategoria\": \"subcategoría si es posible inferir\"\n" +
        "}\n\n" +
        "Si la imagen NO es un comprobante válido o no puedes extraer la información, responde con:\n" +
        "{\n" +
        "  \"error\": \"No se pudo extraer información del comprobante\"\n" +
        "}\n\n" +
        "IMPORTANTE:\n" +
        "- Si es captura de Yape/Plin, extrae el monto, destinatario y fecha\n" +
        "- Si es recibo físico, extrae comercio, monto total y fecha\n" +
        "- Infiere la categoría basándote en el tipo de comercio o descripción\n" +
        "- NO incluyas texto adicional, SOLO el objeto JSON";

      const response = await this.client.messages.create({
        model: "claude-3-5-sonnet-20241022",
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
      functions.logger.info("Anthropic image extraction response:", responseText);

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
        functions.logger.warn("Could not extract receipt data:", parsed.error);
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
      functions.logger.error("Error extracting receipt data with Anthropic:", error);
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
  "fecha": "fecha en formato YYYY-MM-DD (usa la fecha de hoy si no se menciona)"
}

Si el mensaje NO contiene información de un gasto, responde con:
{
  "error": "No se pudo identificar información de gasto en el mensaje"
}

Ejemplos:
- "Gasté 25 soles en almuerzo" → {"monto": 25, "categoria": "comida", "descripcion": "almuerzo", "fecha": "2025-11-25"}
- "50 en taxi" → {"monto": 50, "categoria": "transporte", "descripcion": "taxi", "fecha": "2025-11-25"}
- "Compré medicina por 80" → {"monto": 80, "categoria": "salud", "descripcion": "medicina", "fecha": "2025-11-25"}

NO incluyas texto adicional, SOLO el objeto JSON.`;

      const response = await this.client.messages.create({
        model: "claude-3-5-sonnet-20241022",
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
      functions.logger.info("Anthropic raw response:", responseText);

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
        fecha: parsed.fecha || new Date().toISOString().split("T")[0],
        metodoPago: "efectivo",
        moneda: "PEN",
        subcategoria: null,
        recurrente: false,
        reimbursementStatus: "pending",
        voucherType: "boleta",
      };

      return {
        success: true,
        expenseData,
        rawResponse: responseText,
      };
    } catch (error) {
      functions.logger.error("Error parsing expense with Anthropic:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido al procesar el mensaje",
      };
    }
  }
}
