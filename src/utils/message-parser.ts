import { TwilioWebhookBody } from "../types";

export class MessageParser {
  static normalizePhoneNumber(phone: string): string {
    let normalized = phone.replace(/^whatsapp:/, "");
    normalized = normalized.replace(/[^\d+]/g, "");

    if (!normalized.startsWith("+")) {
      normalized = `+${normalized}`;
    }

    return normalized;
  }

  static isValidWhatsAppMessage(body: TwilioWebhookBody): boolean {
    return (
      !!body &&
      typeof body === "object" &&
      !!body.MessageSid &&
      !!body.From &&
      body.From.startsWith("whatsapp:")
    );
  }

  static hasMedia(body: TwilioWebhookBody): boolean {
    const numMedia = parseInt(body.NumMedia || "0", 10);
    return numMedia > 0 && !!body.MediaUrl0;
  }

  static extractMessageText(body: string): string {
    return body.trim().toLowerCase();
  }

  static isCommandMessage(message: string): { isCommand: boolean; command?: string } {
    const lowerMessage = message.toLowerCase().trim();

    const commandMap: Record<string, string> = {
      "resumen": "resumen",
      "summary": "resumen",
      "total": "resumen",
      "ver gastos": "resumen",
      "ayuda": "ayuda",
      "help": "ayuda",
      "comandos": "ayuda",
      "commands": "ayuda",
      "hola": "inicio",
      "hi": "inicio",
      "inicio": "inicio",
      "start": "inicio",
    };

    for (const [key, value] of Object.entries(commandMap)) {
      if (lowerMessage === key || lowerMessage.startsWith(`/${key}`)) {
        return { isCommand: true, command: value };
      }
    }

    return { isCommand: false };
  }

  static parseExpenseFromText(text: string): {
    amount: number;
    description: string;
  } | null {
    const patterns = [
      /(?:gast[eé]|pagu[eé])\s+(\d+(?:\.\d{1,2})?)\s+(?:soles?\s+)?(?:en\s+)?(.+)/i,
      /(\d+(?:\.\d{1,2})?)\s+(?:soles?\s+)?(?:en\s+)?(.+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const amount = parseFloat(match[1]);
        const description = match[2].trim();

        if (!isNaN(amount) && amount > 0 && description) {
          return { amount, description };
        }
      }
    }

    return null;
  }

  static parseAmount(text: string): number | null {
    const patterns = [
      /(\d+\.?\d*)\s*(?:soles?|s\/\.?|pen)/i,
      /s\/\.?\s*(\d+\.?\d*)/i,
      /(\d+\.?\d*)/,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const amount = parseFloat(match[1]);
        if (!isNaN(amount) && amount > 0) {
          return amount;
        }
      }
    }

    return null;
  }

  static sanitizeInput(input: string): string {
    if (!input) return "";

    return input
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/[<>]/g, "")
      .trim()
      .substring(0, 500);
  }

  static detectPaymentMethodInText(text: string): string | null {
    const lowerText = text.toLowerCase();

    if (lowerText.includes("yape") || lowerText.includes("con yape")) {
      return "yape";
    }
    if (lowerText.includes("plin") || lowerText.includes("con plin")) {
      return "plin";
    }
    if (lowerText.includes("efectivo") || lowerText.includes("en efectivo")) {
      return "efectivo";
    }
    if (lowerText.includes("transferencia")) {
      return "transferencia";
    }
    if (lowerText.includes("tarjeta")) {
      return "tarjeta";
    }

    return null;
  }
}
