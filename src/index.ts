import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { WhatsAppQueueDocument, UserData, TwilioWebhookBody } from "./types";
import { AnthropicService } from "./services/anthropic.service";
import { TwilioService } from "./services/twilio.service";
import { ExpenseService } from "./services/expense.service";
import { UserService } from "./services/user.service";
import { InferenceService } from "./services/inference.service";
import { MessageParser } from "./utils/message-parser";
import { MediaDownloader } from "./utils/media-downloader";

admin.initializeApp();

/**
 * Main Cloud Function - Processes WhatsApp messages from queue
 * Supports both text and image messages
 */
export const processWhatsAppQueue = functions.firestore
  .document("whatsapp_queue/{queueId}")
  .onCreate(async (snap, context) => {
    const queueId = context.params.queueId;
    const data = snap.data() as WhatsAppQueueDocument;

    functions.logger.info(`📨 Processing queue item: ${queueId}`, {
      from: data.phoneNumber,
      hasMedia: !!data.webhookBody.MediaUrl0,
    });

    try {
      await snap.ref.update({
        status: "processing",
        processedAt: Timestamp.now(),
      });

      const phoneNumber = MessageParser.normalizePhoneNumber(data.phoneNumber);
      const message = MessageParser.sanitizeInput(data.message || "");

      // Validate user registration
      const userService = new UserService();
      const user = await userService.findByWhatsAppPhone(phoneNumber);

      if (!user) {
        functions.logger.warn(`User not registered: ${phoneNumber}`);
        const twilioService = new TwilioService();
        await twilioService.sendMessage(
          phoneNumber,
          "❌ No estás registrado en la plataforma.\n\n" +
          "Por favor vincula tu número de WhatsApp desde tu perfil en la aplicación."
        );
        await snap.ref.update({ status: "completed" });
        return;
      }

      functions.logger.info(`✅ User found: ${user.id}`);

      // Check if message has media (image)
      const hasMedia = MessageParser.hasMedia(data.webhookBody);

      if (hasMedia && data.webhookBody.MediaUrl0) {
        await processImageMessage(user, phoneNumber, data.webhookBody, snap);
      } else if (message) {
        await processTextMessage(user, phoneNumber, message, snap);
      } else {
        functions.logger.warn("Message with no text and no media");
        await snap.ref.update({
          status: "completed",
          error: "No content to process",
        });
      }
    } catch (error) {
      functions.logger.error(`Error processing queue item ${queueId}:`, error);

      const retryCount = data.retryCount || 0;

      if (retryCount < 3) {
        await snap.ref.update({
          status: "pending",
          retryCount: retryCount + 1,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      } else {
        await snap.ref.update({
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
        });

        try {
          const phoneNumber = MessageParser.normalizePhoneNumber(data.phoneNumber);
          const twilioService = new TwilioService();
          await twilioService.sendMessage(
            phoneNumber,
            "❌ Error al procesar tu mensaje después de varios intentos. Por favor intenta de nuevo más tarde."
          );
        } catch (sendError) {
          functions.logger.error("Error sending failure notification:", sendError);
        }
      }
    }
  });

/**
 * Process image messages (receipts, Yape/Plin screenshots)
 * @param {UserData} user - User data
 * @param {string} phoneNumber - User's phone number
 * @param {TwilioWebhookBody} webhookBody - Twilio webhook body
 * @param {FirebaseFirestore.DocumentSnapshot} snap - Firestore document snapshot
 */
async function processImageMessage(
  user: UserData,
  phoneNumber: string,
  webhookBody: TwilioWebhookBody,
  snap: FirebaseFirestore.DocumentSnapshot
): Promise<void> {
  const twilioService = new TwilioService();

  try {
    await twilioService.sendMessage(phoneNumber, "⏳ Procesando imagen...");

    // Download image from Twilio
    if (!webhookBody.MediaUrl0) {
      throw new Error("No media URL found");
    }

    const mediaResult = await MediaDownloader.downloadTwilioMedia(
      webhookBody.MediaUrl0
    );

    if (!mediaResult) {
      await twilioService.sendMessage(
        phoneNumber,
        "❌ No pude descargar la imagen. Por favor intenta de nuevo."
      );
      await snap.ref.update({ status: "completed", error: "Failed to download media" });
      return;
    }

    if (!MediaDownloader.isValidImageType(mediaResult.mimeType)) {
      await twilioService.sendMessage(
        phoneNumber,
        "❌ Formato de imagen no soportado. Por favor envía una imagen en formato JPG, PNG o WebP."
      );
      await snap.ref.update({ status: "completed", error: "Invalid image type" });
      return;
    }

    // Extract receipt data using Anthropic Vision
    functions.logger.info("🤖 Extracting receipt data with Anthropic Vision...");
    const anthropicService = new AnthropicService();
    const extractionResult = await anthropicService.extractReceiptData(
      mediaResult.base64,
      mediaResult.mimeType
    );

    if (!extractionResult) {
      await twilioService.sendMessage(
        phoneNumber,
        "❌ No pude extraer información de la imagen. Asegúrate de enviar un comprobante o captura de pago clara."
      );
      await snap.ref.update({ status: "completed", error: "No data extracted from image" });
      return;
    }

    functions.logger.info("✅ Extraction successful:", extractionResult);

    // Infer category and subcategory from user's data
    const inferenceService = new InferenceService();
    const categoryId = await inferenceService.inferCategory(
      user.id,
      extractionResult.categoria || extractionResult.descripcion
    );

    const subcategoryId = await inferenceService.inferSubCategory(
      user.id,
      categoryId,
      extractionResult.subcategoria || extractionResult.descripcion
    );
    const voucherType = inferenceService.inferVoucherType(extractionResult.descripcion);

    // Map payment method
    let paymentMethodId = "efectivo";
    const detectedMethod = extractionResult.metodoPago.toLowerCase();
    if (detectedMethod.includes("yape")) paymentMethodId = "yape";
    else if (detectedMethod.includes("plin")) paymentMethodId = "plin";
    else if (detectedMethod.includes("transferencia")) paymentMethodId = "transferencia";
    else if (detectedMethod.includes("tarjeta")) paymentMethodId = "tarjeta";


    // Save expense
    const expenseService = new ExpenseService();
    const saveResult = await expenseService.saveExpense({
      userId: user.id,
      monto: extractionResult.monto,
      categoria: categoryId,
      descripcion: extractionResult.descripcion,
      fecha: extractionResult.fecha,
      metodoPago: paymentMethodId,
      moneda: extractionResult.moneda,
      subcategoria: subcategoryId,
      recurrente: false,
      reimbursementStatus: "pending",
      voucherType: voucherType,
    });

    if (!saveResult.success) {
      functions.logger.error("Failed to save expense:", saveResult.error);
      await twilioService.sendMessage(
        phoneNumber,
        "❌ Error al guardar el gasto. Por favor intenta de nuevo."
      );
      await snap.ref.update({ status: "failed", error: saveResult.error });
      return;
    }

    // Send confirmation
    let confirmationMessage = "✅ *Gasto registrado por imagen!*\n\n" +
      `💰 Monto: ${extractionResult.moneda} ${extractionResult.monto.toFixed(2)}\n` +
      `📝 Descripción: ${extractionResult.descripcion}\n` +
      `🏷️ Categoría: ${categoryId}\n` +
      `💳 Método: ${paymentMethodId}`;

    if (subcategoryId) {
      confirmationMessage += `\n📂 Subcategoría: ${subcategoryId}`;
    }

    if (extractionResult.comercio) {
      confirmationMessage += `\n🏪 Comercio: ${extractionResult.comercio}`;
    }

    await twilioService.sendMessage(phoneNumber, confirmationMessage);
    await snap.ref.update({ status: "completed" });

    functions.logger.info(`✅ Image expense processed successfully for user ${user.id}`);
  } catch (error) {
    functions.logger.error("Error processing image message:", error);
    await twilioService.sendMessage(
      phoneNumber,
      "❌ Error al procesar la imagen. Por favor intenta de nuevo."
    );
    await snap.ref.update({
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Process text messages (commands or expense descriptions)
 * @param {UserData} user - User data
 * @param {string} phoneNumber - User's phone number
 * @param {string} message - Text message content
 * @param {FirebaseFirestore.DocumentSnapshot} snap - Firestore document snapshot
 */
async function processTextMessage(
  user: UserData,
  phoneNumber: string,
  message: string,
  snap: FirebaseFirestore.DocumentSnapshot
): Promise<void> {
  const twilioService = new TwilioService();

  try {
    // Check if it's a command
    const commandCheck = MessageParser.isCommandMessage(message);

    if (commandCheck.isCommand) {
      await handleCommand(user, phoneNumber, commandCheck.command || "");
      await snap.ref.update({ status: "completed" });
      return;
    }

    // Try to parse as expense with regex first
    const parsedExpense = MessageParser.parseExpenseFromText(message);

    if (parsedExpense) {
      // Successfully parsed with regex
      await registerExpenseFromParsed(
        user,
        phoneNumber,
        parsedExpense.amount,
        parsedExpense.description,
        snap
      );
      return;
    }

    // Fallback to Anthropic for complex messages
    functions.logger.info("Using Anthropic to parse message:", message);
    const anthropicService = new AnthropicService();
    const parseResult = await anthropicService.parseExpenseMessage(message);

    if (!parseResult.success || !parseResult.expenseData) {
      functions.logger.warn("Failed to parse expense:", parseResult.error);
      await twilioService.sendMessage(
        phoneNumber,
        "❌ No pude entender el formato del gasto.\n\n" +
        "💡 Formatos correctos:\n" +
        "• \"50 almuerzo\"\n" +
        "• \"25.50 taxi con yape\"\n" +
        "• \"Gasté 15 soles en bodega\"\n\n" +
        "Escribe \"ayuda\" para más información."
      );
      await snap.ref.update({
        status: "completed",
        error: parseResult.error,
      });
      return;
    }

    // Save expense parsed by Anthropic
    await registerExpenseFromParsed(
      user,
      phoneNumber,
      parseResult.expenseData.monto,
      parseResult.expenseData.descripcion,
      snap
    );
  } catch (error) {
    functions.logger.error("Error processing text message:", error);
    await twilioService.sendMessage(
      phoneNumber,
      "❌ Error al procesar tu mensaje. Por favor intenta de nuevo."
    );
    await snap.ref.update({
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Register expense from parsed data
 * @param {UserData} user - User data
 * @param {string} phoneNumber - User's phone number
 * @param {number} amount - Expense amount
 * @param {string} description - Expense description
 * @param {FirebaseFirestore.DocumentSnapshot} snap - Firestore document snapshot
 */
async function registerExpenseFromParsed(
  user: UserData,
  phoneNumber: string,
  amount: number,
  description: string,
  snap: FirebaseFirestore.DocumentSnapshot
): Promise<void> {
  const twilioService = new TwilioService();
  const inferenceService = new InferenceService();
  const expenseService = new ExpenseService();

  try {
    // Infer category, subcategory, and payment method
    const categoryId = await inferenceService.inferCategory(user.id, description);
    const subcategoryId = await inferenceService.inferSubCategory(user.id, categoryId, description);
    const paymentMethodId = await inferenceService.inferPaymentMethod(user.id, description);
    const currency = inferenceService.inferCurrency(description);
    const voucherType = inferenceService.inferVoucherType(description);

    // Save expense
    const saveResult = await expenseService.saveExpense({
      userId: user.id,
      monto: amount,
      categoria: categoryId,
      descripcion: description,
      fecha: new Date().toISOString(),
      metodoPago: paymentMethodId,
      moneda: currency,
      subcategoria: subcategoryId,
      recurrente: false,
      reimbursementStatus: "pending",
      voucherType: voucherType,
    });

    if (!saveResult.success) {
      functions.logger.error("Failed to save expense:", saveResult.error);
      await twilioService.sendMessage(
        phoneNumber,
        "❌ Error al registrar el gasto. Por favor intenta de nuevo."
      );
      await snap.ref.update({ status: "failed", error: saveResult.error });
      return;
    }

    // Send confirmation
    let confirmationMessage = "✅ *Gasto registrado exitosamente!*\n\n" +
      `💰 Monto: ${amount.toFixed(2)}\n` +
      `📝 Descripción: ${description}\n` +
      `🏷️ Categoría: ${categoryId}\n` +
      `💳 Método: ${paymentMethodId}`;

    if (subcategoryId) {
      confirmationMessage += `\n📂 Subcategoría: ${subcategoryId}`;
    }

    confirmationMessage += "\n\nEscribe \"resumen\" para ver tus gastos.";

    await twilioService.sendMessage(phoneNumber, confirmationMessage);
    await snap.ref.update({ status: "completed" });

    functions.logger.info(`✅ Text expense processed successfully for user ${user.id}`);
  } catch (error) {
    functions.logger.error("Error registering expense:", error);
    await twilioService.sendMessage(
      phoneNumber,
      "❌ Error al registrar el gasto. Por favor intenta de nuevo."
    );
    await snap.ref.update({
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
}

/**
 * Handle command messages
 * @param {UserData} user - User data
 * @param {string} phoneNumber - User's phone number
 * @param {string} command - Command string
 */
async function handleCommand(user: UserData, phoneNumber: string, command: string): Promise<void> {
  const twilioService = new TwilioService();
  const expenseService = new ExpenseService();

  switch (command) {
  case "resumen": {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const summary = await expenseService.getExpenseSummary(user.id);

    if (summary.count === 0) {
      await twilioService.sendMessage(
        phoneNumber,
        "📊 No tienes gastos registrados todavía.\n\n" +
          "Envía un mensaje como:\n" +
          "• \"50 almuerzo\"\n" +
          "• \"25 taxi\"\n" +
          "O envía una foto de tu comprobante."
      );
      return;
    }

    const categoryList = Object.entries(summary.byCategory)
      .map(([cat, amount]) => `  • ${cat}: S/ ${amount.toFixed(2)}`)
      .join("\n");

    const message = "📊 *Resumen de Gastos*\n\n" +
        `💰 Total: S/ ${summary.total.toFixed(2)}\n` +
        `📝 Cantidad: ${summary.count} gastos\n\n` +
        `*Por categoría:*\n${categoryList}`;

    await twilioService.sendMessage(phoneNumber, message);
    break;
  }

  case "ayuda": {
    const message = "🤖 *Asistente de Gastos Inteligente*\n\n" +
        "📝 *Registrar gasto:*\n" +
        "Envía el monto y descripción:\n" +
        "• \"50 almuerzo\"\n" +
        "• \"25.50 taxi con yape\"\n" +
        "• \"Gasté 100 en supermercado\"\n\n" +
        "📷 *Registrar con foto:*\n" +
        "Envía una foto de:\n" +
        "• Comprobante de pago\n" +
        "• Captura de Yape/Plin\n" +
        "• Boleta o factura\n\n" +
        "📊 *Ver resumen:*\n" +
        "Escribe \"resumen\"\n\n" +
        "¡Empieza a registrar tus gastos ahora! 💸";

    await twilioService.sendMessage(phoneNumber, message);
    break;
  }

  case "inicio": {
    const message = `👋 ¡Hola ${user.name || "Usuario"}!\n\n` +
        "Bienvenido a tu Asistente de Gastos Inteligente.\n\n" +
        "Puedes registrar gastos de dos formas:\n\n" +
        "📝 *Escribe el gasto:*\n" +
        "\"50 almuerzo\"\n\n" +
        "📷 *Envía una foto:*\n" +
        "De tu comprobante o captura de pago\n\n" +
        "Escribe \"ayuda\" para ver todos los comandos.";

    await twilioService.sendMessage(phoneNumber, message);
    break;
  }

  default: {
    await twilioService.sendMessage(
      phoneNumber,
      "❌ Comando no reconocido. Escribe \"ayuda\" para ver los comandos disponibles."
    );
  }
  }
}

/**
 * Health check endpoint
 */
export const healthCheck = functions.https.onRequest((req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "gastos-firebase-functions",
    features: {
      textParsing: true,
      imageParsing: true,
      categoryInference: true,
      userValidation: true,
    },
  });
});
