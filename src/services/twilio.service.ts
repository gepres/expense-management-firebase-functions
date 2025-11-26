import * as functions from "firebase-functions/v1";
import twilio from "twilio";

export class TwilioService {
  private client: twilio.Twilio;
  private whatsappNumber: string;

  constructor() {
    const accountSid = functions.config().twilio?.account_sid || process.env.TWILIO_ACCOUNT_SID;
    const authToken = functions.config().twilio?.auth_token || process.env.TWILIO_AUTH_TOKEN;
    this.whatsappNumber = functions.config().twilio?.whatsapp_number ||
      process.env.TWILIO_WHATSAPP_NUMBER ||
      "whatsapp:+14155238886";

    if (!accountSid || !authToken) {
      throw new Error("Twilio credentials not configured");
    }

    this.client = twilio(accountSid, authToken);
  }

  async sendMessage(to: string, message: string): Promise<boolean> {
    try {
      const toNumber = to.startsWith("whatsapp:") ? to : `whatsapp:${to}`;

      functions.logger.info(`Sending WhatsApp message to ${toNumber}`);

      const result = await this.client.messages.create({
        body: message,
        from: this.whatsappNumber,
        to: toNumber,
      });

      functions.logger.info(`Message sent successfully. SID: ${result.sid}`);
      return true;
    } catch (error) {
      functions.logger.error("Error sending WhatsApp message:", error);
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
