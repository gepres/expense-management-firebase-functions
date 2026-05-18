import * as logger from "firebase-functions/logger";
import twilio from "twilio";

// Cliente SDK compartido por instancia (rec. #5 docs/AUDIT.md): se creaba
// uno nuevo en cada `new TwilioService()` (varias veces por mensaje) →
// handshakes TLS y churn. Lazy: las credenciales (secrets) recién están en
// env en runtime, no al cargar el módulo.
let sharedClient: twilio.Twilio | null = null;
function getTwilioClient(): twilio.Twilio {
  if (sharedClient) return sharedClient;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("Twilio credentials not configured");
  }
  sharedClient = twilio(accountSid, authToken);
  return sharedClient;
}

export class TwilioService {
  private client: twilio.Twilio;
  private whatsappNumber: string;

  constructor() {
    this.whatsappNumber =
      process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";
    this.client = getTwilioClient();
  }

  async sendMessage(to: string, message: string): Promise<boolean> {
    try {
      const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

      logger.info(`Sending WhatsApp message to ${toNumber}`);

      const result = await this.client.messages.create({
        body: message,
        from: this.whatsappNumber,
        to: toNumber,
      });

      logger.info(`Message sent successfully. SID: ${result.sid}`);
      return true;
    } catch (error) {
      logger.error("Error sending WhatsApp message:", error);
      return false;
    }
  }

  async sendExpenseConfirmation(
    to: string,
    amount: number,
    category: string,
    description: string,
    date: string
  ): Promise<boolean> {
    const message = `✅ *Gasto registrado exitosamente*

💰 Monto: S/ ${amount.toFixed(2)}
📁 Categoría: ${category}
📝 Descripción: ${description}
📅 Fecha: ${date}

¡Tu gasto ha sido guardado! 🎉`;

    return this.sendMessage(to, message);
  }

  async sendErrorMessage(to: string, errorMessage: string): Promise<boolean> {
    const message = `❌ *Error al procesar tu mensaje*

${errorMessage}

Por favor, intenta de nuevo con un formato como:
- "Gasté 25 soles en almuerzo"
- "50 en taxi"
- "Compré medicina por 80"`;

    return this.sendMessage(to, message);
  }
}
