import * as functions from "firebase-functions/v1";
import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { WhatsAppQueueDocument, UserData, TwilioWebhookBody, Account } from "./types";
import { AnthropicService } from "./services/anthropic.service";
import { TwilioService } from "./services/twilio.service";
import { ExpenseService } from "./services/expense.service";
import { UserService } from "./services/user.service";
import { AccountService } from "./services/account.service";
import { InferenceService } from "./services/inference.service";
import { TranscriptionService } from "./services/transcription.service";
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

      // Resolve active account (session override → primary → first → lazy create)
      const accountService = new AccountService();
      const account = await accountService.resolveActiveAccount(user.id);
      functions.logger.info(
        `💳 Active account: ${account.id} (${account.nombre}, ${account.moneda})`
      );

      // Check if message has media
      const hasMedia = MessageParser.hasMedia(data.webhookBody);

      if (hasMedia && data.webhookBody.MediaUrl0) {
        const mediaContentType = data.webhookBody.MediaContentType0 || "";

        // Check if it's an audio file
        if (MediaDownloader.isValidAudioType(mediaContentType)) {
          await processAudioMessage(user, account, phoneNumber, data.webhookBody, snap);
        } else {
          // Process as image
          await processImageMessage(user, account, phoneNumber, data.webhookBody, snap);
        }
      } else if (message) {
        await processTextMessage(user, account, phoneNumber, message, snap);
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
 * @param {Account} account - Active account
 * @param {string} phoneNumber - User's phone number
 * @param {TwilioWebhookBody} webhookBody - Twilio webhook body
 * @param {FirebaseFirestore.DocumentSnapshot} snap - Firestore document snapshot
 */
async function processImageMessage(
  user: UserData,
  account: Account,
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


    // Receipt currency is explicit document data; fall back to account
    const moneda = extractionResult.moneda || account.moneda;
    const currencySource = extractionResult.moneda ? "text" : "account";

    // Save expense
    const expenseService = new ExpenseService();
    const saveResult = await expenseService.saveExpense({
      userId: user.id,
      accountId: account.id,
      monto: extractionResult.monto,
      categoria: categoryId,
      descripcion: extractionResult.descripcion,
      fecha: extractionResult.fecha,
      metodoPago: paymentMethodId,
      moneda: moneda,
      currencySource: currencySource,
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
      `💰 Monto: ${moneda} ${extractionResult.monto.toFixed(2)}\n` +
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
 * Process audio messages (voice notes with expense information)
 * @param {UserData} user - User data
 * @param {Account} account - Active account
 * @param {string} phoneNumber - User's phone number
 * @param {TwilioWebhookBody} webhookBody - Twilio webhook body
 * @param {FirebaseFirestore.DocumentSnapshot} snap - Firestore document snapshot
 */
async function processAudioMessage(
  user: UserData,
  account: Account,
  phoneNumber: string,
  webhookBody: TwilioWebhookBody,
  snap: FirebaseFirestore.DocumentSnapshot
): Promise<void> {
  const twilioService = new TwilioService();

  try {
    await twilioService.sendMessage(phoneNumber, "🎤 Procesando audio...");

    // Download audio from Twilio
    if (!webhookBody.MediaUrl0) {
      throw new Error("No media URL found");
    }

    const mediaResult = await MediaDownloader.downloadTwilioMedia(
      webhookBody.MediaUrl0
    );

    if (!mediaResult) {
      await twilioService.sendMessage(
        phoneNumber,
        "❌ No pude descargar el audio. Por favor intenta de nuevo."
      );
      await snap.ref.update({ status: "completed", error: "Failed to download audio" });
      return;
    }

    if (!MediaDownloader.isValidAudioType(mediaResult.mimeType)) {
      await twilioService.sendMessage(
        phoneNumber,
        "❌ Formato de audio no soportado. Por favor envía un audio válido."
      );
      await snap.ref.update({ status: "completed", error: "Invalid audio type" });
      return;
    }

    // Transcribe audio using Whisper
    functions.logger.info("🎤 Transcribing audio with Whisper...");
    const transcriptionService = new TranscriptionService();
    const audioBuffer = Buffer.from(mediaResult.base64, "base64");
    const transcription = await transcriptionService.transcribeAudio(
      audioBuffer,
      mediaResult.mimeType
    );

    if (!transcription) {
      await twilioService.sendMessage(
        phoneNumber,
        "❌ No pude transcribir el audio. Asegúrate de hablar claro y en español."
      );
      await snap.ref.update({ status: "completed", error: "Transcription failed" });
      return;
    }

    functions.logger.info(`✅ Transcription: ${transcription}`);

    // Process transcription as text message
    await twilioService.sendMessage(
      phoneNumber,
      `📝 Entendí: "${transcription}"\n\n⏳ Procesando...`
    );

    // Parse expense from transcription using Anthropic
    const anthropicService = new AnthropicService();
    const parseResult = await anthropicService.parseExpenseMessage(transcription);

    if (!parseResult.success || !parseResult.expenseData) {
      await twilioService.sendMessage(
        phoneNumber,
        "❌ No pude identificar un gasto en tu audio. Intenta decir algo como:\n" +
        "\"Gasté 25 soles en almuerzo\" o \"50 en taxi\""
      );
      await snap.ref.update({ status: "completed", error: parseResult.error });
      return;
    }

    // Infer additional data
    const inferenceService = new InferenceService();
    const categoryId = await inferenceService.inferCategory(
      user.id,
      parseResult.expenseData.descripcion
    );

    const subcategoryId = await inferenceService.inferSubCategory(
      user.id,
      categoryId,
      parseResult.expenseData.descripcion
    );

    const paymentMethodId = await inferenceService.inferPaymentMethod(
      user.id,
      transcription
    );

    const { moneda: currency, source: currencySource } =
      inferenceService.resolveCurrency(transcription, account.moneda);
    const voucherType = inferenceService.inferVoucherType(transcription);

    // Save expense
    const expenseService = new ExpenseService();
    const saveResult = await expenseService.saveExpense({
      userId: user.id,
      accountId: account.id,
      monto: parseResult.expenseData.monto,
      categoria: categoryId,
      descripcion: parseResult.expenseData.descripcion,
      fecha: parseResult.expenseData.fecha,
      metodoPago: paymentMethodId,
      moneda: currency,
      currencySource: currencySource,
      subcategoria: subcategoryId,
      recurrente: false,
      reimbursementStatus: "pending",
      voucherType: voucherType,
    });

    if (!saveResult.success) {
      await twilioService.sendMessage(
        phoneNumber,
        "❌ Error al guardar el gasto. Por favor intenta de nuevo."
      );
      await snap.ref.update({ status: "failed", error: saveResult.error });
      return;
    }

    // Send confirmation
    let confirmationMessage = "✅ *Gasto registrado por audio!*\n\n" +
      `💰 Monto: ${currency} ${parseResult.expenseData.monto.toFixed(2)}\n` +
      `📝 Descripción: ${parseResult.expenseData.descripcion}\n` +
      `🏷️ Categoría: ${categoryId}\n` +
      `💳 Método: ${paymentMethodId}`;

    if (subcategoryId) {
      confirmationMessage += `\n📂 Subcategoría: ${subcategoryId}`;
    }

    await twilioService.sendMessage(phoneNumber, confirmationMessage);
    await snap.ref.update({ status: "completed" });

    functions.logger.info(`✅ Audio expense processed successfully for user ${user.id}`);
  } catch (error) {
    functions.logger.error("Error processing audio message:", error);
    await twilioService.sendMessage(
      phoneNumber,
      "❌ Error al procesar el audio. Por favor intenta de nuevo."
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
 * @param {Account} account - Active account
 * @param {string} phoneNumber - User's phone number
 * @param {string} message - Text message content
 * @param {FirebaseFirestore.DocumentSnapshot} snap - Firestore document snapshot
 */
async function processTextMessage(
  user: UserData,
  account: Account,
  phoneNumber: string,
  message: string,
  snap: FirebaseFirestore.DocumentSnapshot
): Promise<void> {
  const twilioService = new TwilioService();

  try {
    // Account commands (usar cuenta / cuenta actual / cuenta principal)
    const accountCommand = MessageParser.parseAccountCommand(message);
    if (accountCommand) {
      await handleAccountCommand(user, account, phoneNumber, accountCommand);
      await snap.ref.update({ status: "completed" });
      return;
    }

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
        account,
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
      account,
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
 * @param {Account} account - Active account
 * @param {string} phoneNumber - User's phone number
 * @param {number} amount - Expense amount
 * @param {string} description - Expense description
 * @param {FirebaseFirestore.DocumentSnapshot} snap - Firestore document snapshot
 */
async function registerExpenseFromParsed(
  user: UserData,
  account: Account,
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
    const { moneda: currency, source: currencySource } =
      inferenceService.resolveCurrency(description, account.moneda);
    const voucherType = inferenceService.inferVoucherType(description);

    // Save expense
    const saveResult = await expenseService.saveExpense({
      userId: user.id,
      accountId: account.id,
      monto: amount,
      categoria: categoryId,
      descripcion: description,
      fecha: new Date().toISOString(),
      metodoPago: paymentMethodId,
      moneda: currency,
      currencySource: currencySource,
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
 * Handle account commands (usar cuenta / cuenta actual / cuenta principal)
 * @param {UserData} user - User data
 * @param {Account} account - Currently active account
 * @param {string} phoneNumber - User's phone number
 * @param {object} cmd - Parsed account command
 */
async function handleAccountCommand(
  user: UserData,
  account: Account,
  phoneNumber: string,
  cmd: { kind: "use" | "current" | "primary"; nombre?: string }
): Promise<void> {
  const twilioService = new TwilioService();
  const accountService = new AccountService();

  if (cmd.kind === "current") {
    await twilioService.sendMessage(
      phoneNumber,
      `💳 *Cuenta activa:* ${account.nombre}\n` +
        `💱 Moneda: ${account.moneda}\n` +
        `💰 Saldo: ${account.moneda} ${account.saldo.toFixed(2)}`
    );
    return;
  }

  if (cmd.kind === "primary") {
    await accountService.clearSessionAccount(user.id);
    const primary = await accountService.getPrimary(user.id);
    await twilioService.sendMessage(
      phoneNumber,
      primary ?
        `✅ Volviste a tu cuenta principal: *${primary.nombre}*` :
        "✅ Sesión de cuenta restablecida a la principal."
    );
    return;
  }

  const target = cmd.nombre ?
    await accountService.findByNombre(user.id, cmd.nombre) :
    null;

  if (!target) {
    const all = await accountService.listByUser(user.id);
    const names = all.map((a) => `• ${a.nombre}`).join("\n");
    await twilioService.sendMessage(
      phoneNumber,
      `❌ No encontré la cuenta "${cmd.nombre}".\n\n` +
        `Tus cuentas:\n${names}`
    );
    return;
  }

  await accountService.setSessionAccount(user.id, target.id);
  await twilioService.sendMessage(
    phoneNumber,
    `✅ Cuenta activa: *${target.nombre}* (${target.moneda}).\n` +
      "Se mantendrá durante esta conversación. " +
      "Escribe \"cuenta principal\" para volver."
  );
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
