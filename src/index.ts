import {
  onDocumentCreated,
  onDocumentUpdated,
} from "firebase-functions/v2/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import {
  WhatsAppQueueDocument,
  UserData,
  TwilioWebhookBody,
  Account,
  LearningSource,
  BotCommand,
  QueryCommand,
  EditCommand,
  PendingAction,
} from "./types";
import { AnthropicService } from "./services/anthropic.service";
import { TwilioService } from "./services/twilio.service";
import { ExpenseService } from "./services/expense.service";
import { UserService } from "./services/user.service";
import {
  AccountService,
  NoCanonicalAccountError,
} from "./services/account.service";
import {
  InferenceService,
  categoryIdForTerm,
} from "./services/inference.service";
import { LearningLogService } from "./services/learning-log.service";
import { OnboardingService } from "./services/onboarding.service";
import { PendingActionService } from "./services/pending-action.service";
import { TranscriptionService } from "./services/transcription.service";
import {
  buildHelpMenu,
  buildHelpTopic,
  buildOnboarding,
  resolveHelpTopic,
} from "./config/help";
import { MessageParser } from "./utils/message-parser";
import { MediaDownloader } from "./utils/media-downloader";
import {
  validateTwilioRequest,
  buildQueueDocFromTwilio,
} from "./utils/twilio-webhook";
import { toCsv } from "./utils/csv";

admin.initializeApp();

// Secrets v2 (reemplazan functions.config()). Al bindearlos a la función,
// sus valores quedan expuestos como process.env.<NAME> en runtime, que es
// lo que leen los services.
const TWILIO_ACCOUNT_SID = defineSecret("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = defineSecret("TWILIO_AUTH_TOKEN");
const TWILIO_WHATSAPP_NUMBER = defineSecret("TWILIO_WHATSAPP_NUMBER");
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");

/**
 * Main Cloud Function - Processes WhatsApp messages from queue
 * Supports text, image and audio messages
 */
export const processWhatsAppQueue = onDocumentCreated(
  {
    document: "whatsapp_queue/{queueId}",
    secrets: [
      TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN,
      TWILIO_WHATSAPP_NUMBER,
      ANTHROPIC_API_KEY,
      OPENAI_API_KEY,
    ],
  },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      logger.warn("processWhatsAppQueue: event sin data");
      return;
    }
    const queueId = event.params.queueId;
    const data = snap.data() as WhatsAppQueueDocument;

    logger.info(`📨 Processing queue item: ${queueId}`, {
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
        logger.warn(`User not registered: ${phoneNumber}`);
        const twilioService = new TwilioService();
        await twilioService.sendMessage(
          phoneNumber,
          "❌ No estás registrado en la plataforma.\n\n" +
          "Por favor vincula tu número de WhatsApp desde tu perfil en la aplicación."
        );
        await snap.ref.update({ status: "completed" });
        return;
      }

      logger.info(`✅ User found: ${user.id}`);

      // Onboarding automático en el primer contacto tras vincular WhatsApp.
      // Idempotente (no se repite en reintentos de Twilio). Guard: si el
      // usuario ya tiene historial de aprendizaje es alguien previo a esta
      // feature → no lo saludamos (evita spam tras el deploy).
      const onboardingService = new OnboardingService();
      const claimedFirstContact =
        await onboardingService.tryClaimFirstContact(user.id);
      if (claimedFirstContact) {
        const priorLog = await new LearningLogService().getRecent(user.id, 1);
        if (priorLog.length === 0) {
          const twilioService = new TwilioService();
          await twilioService.sendMessage(
            phoneNumber,
            buildOnboarding(user.name, true)
          );
          // Si el primer mensaje era solo un saludo/ayuda/vacío, la
          // bienvenida ya lo respondió: cerramos sin re-procesar (evita
          // doble bienvenida). Si trajo un gasto/comando real, seguimos.
          const greetingOnly =
            !MessageParser.hasMedia(data.webhookBody) &&
            (!message ||
              MessageParser.isCommandMessage(message).command === "inicio" ||
              MessageParser.parseHelpCommand(message) !== null);
          if (greetingOnly) {
            await snap.ref.update({ status: "completed" });
            return;
          }
        }
      }

      // Resolve active account (session override → primary → first).
      // Sin cuenta canónica el bot no puede registrar: en vez de
      // reintentar 3× y fallar con un genérico, guiamos al usuario.
      const accountService = new AccountService();
      let account: Account;
      try {
        account = await accountService.resolveActiveAccount(user.id);
      } catch (accErr) {
        if (accErr instanceof NoCanonicalAccountError) {
          const webapp = process.env.WEBAPP_URL;
          const twilioService = new TwilioService();
          await twilioService.sendMessage(
            phoneNumber,
            "👋 Casi listo. Aún no tienes una *cuenta* creada, " +
            "así que todavía no puedo registrar tus gastos.\n\n" +
            "Crea tu cuenta desde la app (sección *Cuentas*)" +
            (webapp ? `:\n${webapp}` : ".") +
            "\n\nLuego reenvíame tu mensaje y lo registro. 💸"
          );
          await snap.ref.update({
            status: "completed",
            error: "no canonical account",
          });
          return;
        }
        throw accErr;
      }
      logger.info(
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
        logger.warn("Message with no text and no media");
        await snap.ref.update({
          status: "completed",
          error: "No content to process",
        });
      }
    } catch (error) {
      logger.error(`Error processing queue item ${queueId}:`, error);

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
          logger.error("Error sending failure notification:", sendError);
        }
      }
    }
  }
);

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
    logger.info("🤖 Extracting receipt data with Anthropic Vision...");
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

    logger.info("✅ Extraction successful:", extractionResult);

    // Receipt date is explicit document data extracted by Vision (LLM).
    let fechaExplicitISO: string | undefined;
    if (extractionResult.fecha) {
      const d = new Date(extractionResult.fecha);
      if (!isNaN(d.getTime())) fechaExplicitISO = d.toISOString();
    }

    const classifyText = [
      extractionResult.descripcion,
      extractionResult.categoria,
      extractionResult.comercio,
    ]
      .filter(Boolean)
      .join(" ");

    await finalizeAndRegisterExpense({
      user,
      account,
      phoneNumber,
      snap,
      channel: "image",
      rawText: classifyText,
      description: extractionResult.descripcion,
      amount: extractionResult.monto,
      successTitle: "✅ *Gasto registrado por imagen!*",
      explicitCurrency: extractionResult.moneda || undefined,
      paymentHint: extractionResult.metodoPago,
      categoryHint: extractionResult.categoria || undefined,
      fechaExplicitISO: fechaExplicitISO,
      comercio: extractionResult.comercio,
    });
  } catch (error) {
    logger.error("Error processing image message:", error);
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
    logger.info("🎤 Transcribing audio with Whisper...");
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

    logger.info(`✅ Transcription: ${transcription}`);

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

    await finalizeAndRegisterExpense({
      user,
      account,
      phoneNumber,
      snap,
      channel: "audio",
      rawText: transcription,
      description: parseResult.expenseData.descripcion,
      amount: parseResult.expenseData.monto,
      successTitle: "✅ *Gasto registrado por audio!*",
      categoryHint: parseResult.expenseData.categoria || undefined,
    });
  } catch (error) {
    logger.error("Error processing audio message:", error);
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
    // Confirmación de una acción pendiente (estado de conversación).
    // PRIMERO: un "sí/no" suelto debe interpretarse como respuesta,
    // no como gasto/comando.
    const pendingService = new PendingActionService();
    const pending = await pendingService.get(user.id);
    if (pending) {
      const conf = MessageParser.parseConfirmation(message);
      if (conf === "yes") {
        await executePendingAction(phoneNumber, pending);
        await pendingService.clear(user.id);
        await snap.ref.update({ status: "completed" });
        return;
      }
      if (conf === "no") {
        await pendingService.clear(user.id);
        await twilioService.sendMessage(
          phoneNumber,
          "👍 Ok, no hice ningún cambio."
        );
        await snap.ref.update({ status: "completed" });
        return;
      }
      // Mensaje no relacionado → se abandona la confirmación y se
      // procesa normal (no dejar al usuario atrapado).
      await pendingService.clear(user.id);
    }

    // Account commands (usar cuenta / cuenta actual / cuenta principal)
    const accountCommand = MessageParser.parseAccountCommand(message);
    if (accountCommand) {
      await handleAccountCommand(user, account, phoneNumber, accountCommand);
      await snap.ref.update({ status: "completed" });
      return;
    }

    // Bot commands (saldo / ingreso / transferir / pendientes / historial)
    const botCommand = MessageParser.parseBotCommand(message);
    if (botCommand) {
      await handleBotCommand(user, account, phoneNumber, botCommand);
      await snap.ref.update({ status: "completed" });
      return;
    }

    // Ayuda: "ayuda" (menú) / "ayuda <tema>" (detalle).
    const helpCmd = MessageParser.parseHelpCommand(message);
    if (helpCmd) {
      const topic = resolveHelpTopic(helpCmd.rest);
      await twilioService.sendMessage(
        phoneNumber,
        topic ? buildHelpTopic(topic) : buildHelpMenu()
      );
      await snap.ref.update({ status: "completed" });
      return;
    }

    // Consultas de solo-lectura ("cuanto gaste hoy", "mis categorias"…).
    const queryCmd = MessageParser.parseQueryCommand(message);
    if (queryCmd) {
      await handleQueryCommand(user, account, phoneNumber, queryCmd);
      await snap.ref.update({ status: "completed" });
      return;
    }

    // Editar el último gasto sin IDs (borrar / corregir monto).
    // Deja una acción pendiente de confirmación (sí/no).
    const editCmd = MessageParser.parseEditCommand(message);
    if (editCmd) {
      await handleEditCommand(user, phoneNumber, editCmd);
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
        snap,
        message
      );
      return;
    }

    // Fallback to Anthropic for complex messages
    logger.info("Using Anthropic to parse message:", message);
    const anthropicService = new AnthropicService();
    const parseResult = await anthropicService.parseExpenseMessage(message);

    if (!parseResult.success || !parseResult.expenseData) {
      logger.warn("Failed to parse expense:", parseResult.error);
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
      snap,
      message,
      parseResult.expenseData.categoria
    );
  } catch (error) {
    logger.error("Error processing text message:", error);
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
 * Maps a classification matchedLevel to a learning_log decision source.
 * @param {string} level - matchedLevel from classify()
 * @return {LearningSource} learning_log source
 */
function levelToSource(level: string): LearningSource {
  if (level === "history") return "history";
  if (level === "llm") return "llm";
  if (level === "user_correction") return "user_correction";
  if (level === "default") return "default";
  return "regex";
}

interface FinalizeArgs {
  user: UserData;
  account: Account;
  phoneNumber: string;
  snap: FirebaseFirestore.DocumentSnapshot;
  channel: "text" | "image" | "audio";
  rawText: string;
  description: string;
  amount: number;
  successTitle: string;
  explicitCurrency?: string;
  paymentHint?: string;
  categoryHint?: string;
  fechaExplicitISO?: string;
  comercio?: string;
}

/**
 * Shared expense finalization: validate amount, classify, resolve payment /
 * currency / date, persist (expense + movement + saldo), log the decision
 * to learning_log and confirm to the user. ROADMAP § B.3–B.6 + § G.
 * @param {FinalizeArgs} args - Finalization arguments
 * @return {Promise<void>} resolves when done
 */
async function finalizeAndRegisterExpense(args: FinalizeArgs): Promise<void> {
  const twilioService = new TwilioService();
  const inferenceService = new InferenceService();
  const expenseService = new ExpenseService();
  const learningLog = new LearningLogService();
  const anthropicService = new AnthropicService();
  const { user, account, phoneNumber, snap } = args;

  const matchText = args.rawText || args.description;

  const amountCheck = MessageParser.validateAmount(args.amount);
  if (!amountCheck.ok || amountCheck.value === undefined) {
    await twilioService.sendMessage(
      phoneNumber,
      `❌ ${amountCheck.error}\n\nEjemplo: "50 almuerzo"`
    );
    await snap.ref.update({ status: "completed", error: amountCheck.error });
    return;
  }
  const monto = amountCheck.value;

  const queueDoc = snap.data() as WhatsAppQueueDocument;
  const messageSid = queueDoc?.webhookBody?.MessageSid;
  const messageDate = queueDoc?.createdAt ?
    queueDoc.createdAt.toDate() :
    new Date();

  // Idempotencia (§ C.1): Twilio puede reintentar el webhook.
  if (messageSid) {
    const dup = await expenseService.findByMessageSid(messageSid);
    if (dup) {
      logger.info(
        `Duplicate messageSid ${messageSid} → expense ${dup.id}, skipping`
      );
      await twilioService.sendMessage(
        phoneNumber,
        "ℹ️ Este gasto ya estaba registrado. No lo dupliqué."
      );
      await snap.ref.update({ status: "completed", error: "duplicate" });
      return;
    }
  }

  const classification = await inferenceService.classify(
    user.id,
    matchText,
    args.categoryHint
  );
  const payment = await inferenceService.resolvePaymentMethod(
    user.id,
    matchText,
    args.paymentHint
  );

  // § G.1: método ambiguo → desambiguar con Anthropic contra los
  // métodos conocidos del usuario antes de marcarlo "otro"/needsReview.
  let metodoPago = payment.metodoPago;
  let paymentSource: typeof payment.source = payment.source;
  let paymentNeedsReview = payment.needsReview;
  if (paymentNeedsReview && args.paymentHint) {
    const methods = await inferenceService.getPaymentMethods(user.id);
    const nameToId = new Map<string, string>();
    ["yape", "plin", "efectivo", "transferencia", "tarjeta"].forEach((d) =>
      nameToId.set(d, d)
    );
    methods.forEach((mth) => nameToId.set(mth.nombre, mth.id));
    const picked = await anthropicService.disambiguatePaymentMethod(
      args.paymentHint,
      Array.from(nameToId.keys())
    );
    if (picked) {
      metodoPago = nameToId.get(picked) ?? picked;
      paymentSource = "inferred";
      paymentNeedsReview = false;
    }
  }

  const currency = args.explicitCurrency ?
    { moneda: args.explicitCurrency, source: "text" as const } :
    inferenceService.resolveCurrency(matchText, account.moneda);

  let fechaISO: string;
  let dateSource: "regex" | "llm" | "message";
  if (args.fechaExplicitISO) {
    fechaISO = args.fechaExplicitISO;
    dateSource = "llm";
  } else {
    const parsed = MessageParser.parseDateFromText(matchText);
    if (parsed) {
      fechaISO = parsed.toISOString();
      dateSource = "regex";
    } else if (MessageParser.hasTemporalHint(matchText)) {
      // § G.1: el regex no resolvió pero hay pista temporal → LLM.
      const llmDate = await anthropicService.parseRelativeDate(
        matchText,
        messageDate.toISOString().slice(0, 10)
      );
      if (llmDate) {
        fechaISO = new Date(`${llmDate}T12:00:00`).toISOString();
        dateSource = "llm";
      } else {
        fechaISO = messageDate.toISOString();
        dateSource = "message";
      }
    } else {
      fechaISO = messageDate.toISOString();
      dateSource = "message";
    }
  }

  // § G.1: detección de monto atípico vs mediana del usuario. No bloquea
  // (el flujo es async); registra el gasto y lo marca para revisión.
  let amountFlagged = false;
  const recentAmounts = await expenseService.getRecentAmounts(user.id, 50);
  if (recentAmounts.length >= 8) {
    const sorted = [...recentAmounts].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ?
      sorted[mid] :
      (sorted[mid - 1] + sorted[mid]) / 2;
    if (median > 0 && monto > median * 10) {
      amountFlagged = true;
    }
  }

  const voucherType = inferenceService.inferVoucherType(matchText);

  const saveResult = await expenseService.saveExpense({
    userId: user.id,
    accountId: account.id,
    monto: monto,
    categoria: classification.categoria,
    descripcion: args.description,
    fecha: fechaISO,
    metodoPago: payment.metodoPago,
    moneda: currency.moneda,
    subcategoria: classification.subcategoria,
    recurrente: false,
    reimbursementStatus: "pending",
    voucherType: voucherType,
    matchedTerm: classification.matchedTerm,
    matchedLevel: classification.matchedLevel,
    currencySource: currency.source,
    dateSource: dateSource,
    paymentMethodSource: paymentSource,
    needsClassification: classification.needsClassification,
    needsReview: paymentNeedsReview,
    amountFlagged: amountFlagged,
    messageSid: messageSid,
  });

  if (!saveResult.success) {
    logger.error("Failed to save expense:", saveResult.error);
    await twilioService.sendMessage(
      phoneNumber,
      "❌ Error al registrar el gasto. Por favor intenta de nuevo."
    );
    await snap.ref.update({ status: "failed", error: saveResult.error });
    return;
  }

  await learningLog.append(user.id, {
    expenseId: saveResult.expenseId,
    type: "classification",
    input: {
      raw: matchText,
      normalized: MessageParser.normalizeForMatching(matchText),
      channel: args.channel,
    },
    decision: {
      field: "categoria",
      value: classification.categoria,
      source: levelToSource(classification.matchedLevel),
      matchedTerm: classification.matchedTerm ?? undefined,
    },
  });

  let msg = `${args.successTitle}\n\n` +
    `💰 Monto: ${currency.moneda} ${monto.toFixed(2)}\n` +
    `📝 Descripción: ${args.description}\n` +
    `🏷️ Categoría: ${classification.categoria}\n` +
    `💳 Método: ${metodoPago}`;
  if (classification.subcategoria) {
    msg += `\n📂 Subcategoría: ${classification.subcategoria}`;
  }
  if (args.comercio) {
    msg += `\n🏪 Comercio: ${args.comercio}`;
  }
  if (classification.needsClassification) {
    msg += "\n\n⚠️ No pude clasificar este gasto. " +
      "Quedó como *sin_clasificar*; puedes crear la categoría/subcategoría " +
      "o escribir \"pendientes\" para clasificarlo después.";
  }
  if (paymentNeedsReview) {
    msg += "\n\n⚠️ No reconocí el método de pago; quedó como *otro*. " +
      "Revísalo o créalo en tus métodos de pago.";
  }
  if (amountFlagged) {
    msg += "\n\n⚠️ Este monto es inusualmente alto vs tu histórico. " +
      "Si fue un error, escribe \"pendientes\" para corregirlo.";
  }

  await twilioService.sendMessage(phoneNumber, msg);
  await snap.ref.update({ status: "completed" });
  logger.info(
    `✅ ${args.channel} expense ${saveResult.expenseId} for user ${user.id}`
  );
}

/**
 * Register expense from parsed text/regex/Anthropic data
 * @param {UserData} user - User data
 * @param {Account} account - Active account
 * @param {string} phoneNumber - User's phone number
 * @param {number} amount - Expense amount
 * @param {string} description - Expense description
 * @param {FirebaseFirestore.DocumentSnapshot} snap - Firestore document snapshot
 * @param {string} rawText - Original message text
 * @param {string} [categoryHint] - Free-form category from the LLM (only
 *   when parsed by Anthropic; regex path has none)
 */
async function registerExpenseFromParsed(
  user: UserData,
  account: Account,
  phoneNumber: string,
  amount: number,
  description: string,
  snap: FirebaseFirestore.DocumentSnapshot,
  rawText: string,
  categoryHint?: string
): Promise<void> {
  try {
    await finalizeAndRegisterExpense({
      user,
      account,
      phoneNumber,
      snap,
      channel: "text",
      rawText: rawText,
      description: description,
      amount: amount,
      successTitle: "✅ *Gasto registrado exitosamente!*",
      categoryHint: categoryHint,
    });
  } catch (error) {
    const twilioService = new TwilioService();
    logger.error("Error registering expense:", error);
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
 * Handle read-only queries: the bot should answer, not only record.
 * @param {UserData} user - User data
 * @param {Account} account - Active account (display currency)
 * @param {string} phoneNumber - User's phone number
 * @param {QueryCommand} cmd - Parsed query command
 * @return {Promise<void>} resolves when done
 */
async function handleQueryCommand(
  user: UserData,
  account: Account,
  phoneNumber: string,
  cmd: QueryCommand
): Promise<void> {
  const twilioService = new TwilioService();
  const expenseService = new ExpenseService();
  const inferenceService = new InferenceService();
  const accountService = new AccountService();

  try {
    if (cmd.kind === "categories") {
      const cats = await inferenceService.getCategories(user.id);
      if (cats.length === 0) {
        await twilioService.sendMessage(
          phoneNumber,
          "Aún no tienes categorías. Créalas en la app; mientras " +
          "tanto registro tus gastos como *sin_clasificar* y los " +
          "puedes ordenar luego (escribe *pendientes*)."
        );
        return;
      }
      const lines = cats
        .map((c) => {
          const subs = (c.subcategorias || [])
            .map((s) => s.nombre)
            .filter(Boolean);
          return (
            `• *${c.nombre}*` +
            (subs.length ? `\n   ${subs.join(", ")}` : "")
          );
        })
        .join("\n");
      await twilioService.sendMessage(
        phoneNumber,
        `🏷️ *Tus categorías*\n\n${lines}`
      );
      return;
    }

    if (cmd.kind === "accounts") {
      const accts = await accountService.listCanonical(user.id);
      if (accts.length === 0) {
        await twilioService.sendMessage(
          phoneNumber,
          "No encontré cuentas. Créalas en la app (sección Cuentas)."
        );
        return;
      }
      const lines = accts
        .map((a) => {
          const tags = [
            a.isPrimary ? "principal" : null,
            a.id === account.id ? "activa" : null,
          ]
            .filter(Boolean)
            .join(", ");
          return `• *${a.nombre}* (${a.moneda})${tags ? ` — ${tags}` : ""}`;
        })
        .join("\n");
      await twilioService.sendMessage(
        phoneNumber,
        `💳 *Tus cuentas*\n\n${lines}\n\n` +
        "Cambia con: *usar cuenta <nombre>*"
      );
      return;
    }

    if (cmd.kind === "payments") {
      const methods = await inferenceService.getPaymentMethods(user.id);
      const defaults = [
        "efectivo", "yape", "plin", "transferencia", "tarjeta",
      ];
      const propios = methods.map((p) => p.nombre).filter(Boolean);
      let msg =
        "💳 *Métodos de pago*\n\nSiempre disponibles:\n" +
        defaults.map((d) => `• ${d}`).join("\n");
      if (propios.length) {
        msg += "\n\nTuyos:\n" + propios.map((p) => `• ${p}`).join("\n");
      }
      msg += "\n\nMenciónalo en el gasto: \"50 almuerzo con yape\".";
      await twilioService.sendMessage(phoneNumber, msg);
      return;
    }

    // spent / list: resolver periodo a un rango.
    const period = MessageParser.resolveQueryPeriod(cmd.periodRaw);

    if (cmd.kind === "list") {
      const items = await expenseService.getExpensesBetween(
        user.id,
        period.start,
        period.end,
        15
      );
      if (items.length === 0) {
        await twilioService.sendMessage(
          phoneNumber,
          `📭 No registraste gastos ${period.label}.`
        );
        return;
      }
      const lines = items
        .map(
          (it) =>
            `• ${it.moneda} ${it.monto.toFixed(2)} — ${it.descripcion}`
        )
        .join("\n");
      const total = items
        .reduce((acc, it) => acc + it.monto, 0)
        .toFixed(2);
      await twilioService.sendMessage(
        phoneNumber,
        `🧾 *Gastos ${period.label}* (${items.length})\n\n${lines}\n\n` +
        `Σ ${account.moneda} ${total}`
      );
      return;
    }

    // cmd.kind === "spent"
    const summary = await expenseService.getSummaryBetween(
      user.id,
      period.start,
      period.end
    );

    if (cmd.categoria) {
      const cats = await inferenceService.getCategories(user.id);
      const catId = categoryIdForTerm(cmd.categoria, cats);
      const key = catId ?? cmd.categoria;
      const monto = summary.byCategory[key] ?? 0;
      const nombre =
        cats.find((c) => c.id === catId)?.nombre ?? cmd.categoria;
      await twilioService.sendMessage(
        phoneNumber,
        `🏷️ *${nombre}* — ${period.label}\n` +
        `💰 ${account.moneda} ${monto.toFixed(2)}` +
        (monto === 0 ?
          "\n\n(0 gastos en esa categoría/periodo)" :
          "")
      );
      return;
    }

    if (summary.count === 0) {
      await twilioService.sendMessage(
        phoneNumber,
        `📭 No registraste gastos ${period.label}.`
      );
      return;
    }
    const cats = await inferenceService.getCategories(user.id);
    const nameOf = (id: string): string =>
      id === "sin_clasificar" ?
        "sin clasificar" :
        cats.find((c) => c.id === id)?.nombre ?? id;
    const top = Object.entries(summary.byCategory)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, amt]) => `  • ${nameOf(id)}: ${amt.toFixed(2)}`)
      .join("\n");
    await twilioService.sendMessage(
      phoneNumber,
      `📊 *${period.label}*\n\n` +
      `💰 Total de ${period.label}: ` +
      `${account.moneda} ${summary.total.toFixed(2)}\n` +
      `📝 ${summary.count} gastos\n\n` +
      `*Top categorías de ${period.label}:*\n${top}`
    );
  } catch (error) {
    logger.error("Error handling query command:", error);
    await twilioService.sendMessage(
      phoneNumber,
      "❌ No pude obtener esa información. Intenta de nuevo."
    );
  }
}

/**
 * Edición del último gasto: valida y deja una acción pendiente de
 * confirmación (no muta nada todavía — eso lo hace executePendingAction
 * al recibir "sí").
 * @param {UserData} user - User data
 * @param {string} phoneNumber - User's phone number
 * @param {EditCommand} cmd - Parsed edit command
 * @return {Promise<void>} resolves when done
 */
async function handleEditCommand(
  user: UserData,
  phoneNumber: string,
  cmd: EditCommand
): Promise<void> {
  const twilioService = new TwilioService();
  const expenseService = new ExpenseService();
  const pendingService = new PendingActionService();

  const last = await expenseService.getLastExpense(user.id);
  if (!last) {
    await twilioService.sendMessage(
      phoneNumber,
      "No encontré un gasto reciente tuyo para modificar."
    );
    return;
  }

  if (cmd.kind === "delete_last") {
    await pendingService.set(user.id, {
      kind: "delete_last",
      expenseId: last.id,
      descripcion: last.descripcion,
      moneda: last.moneda,
      montoActual: last.monto,
    });
    await twilioService.sendMessage(
      phoneNumber,
      "🗑️ ¿Borro tu último gasto?\n\n" +
      `*${last.moneda} ${last.monto.toFixed(2)}* — ${last.descripcion}\n\n` +
      "Responde *sí* o *no*."
    );
    return;
  }

  // correct_amount
  const check = MessageParser.validateAmount(cmd.monto);
  if (!check.ok || check.value === undefined) {
    await twilioService.sendMessage(phoneNumber, `❌ ${check.error}`);
    return;
  }
  await pendingService.set(user.id, {
    kind: "correct_amount",
    expenseId: last.id,
    descripcion: last.descripcion,
    moneda: last.moneda,
    montoActual: last.monto,
    montoNuevo: check.value,
  });
  await twilioService.sendMessage(
    phoneNumber,
    `✏️ ¿Corrijo el monto de *${last.descripcion}*?\n\n` +
    `${last.moneda} ${last.monto.toFixed(2)} → ` +
    `*${last.moneda} ${check.value.toFixed(2)}*\n\n` +
    "Responde *sí* o *no*."
  );
}

/**
 * Ejecuta una acción confirmada (el usuario respondió "sí").
 * @param {string} phoneNumber - User's phone number
 * @param {PendingAction} pending - The confirmed pending action
 * @return {Promise<void>} resolves when done
 */
async function executePendingAction(
  phoneNumber: string,
  pending: PendingAction
): Promise<void> {
  const twilioService = new TwilioService();
  const expenseService = new ExpenseService();

  if (pending.kind === "delete_last") {
    const ok = await expenseService.deleteExpense(pending.expenseId);
    await twilioService.sendMessage(
      phoneNumber,
      ok ?
        `🗑️ Listo, borré *${pending.moneda} ` +
          `${pending.montoActual.toFixed(2)}* — ${pending.descripcion}.` :
        "❌ No pude borrar el gasto. Intenta de nuevo."
    );
    return;
  }

  // correct_amount
  if (pending.montoNuevo === undefined) {
    await twilioService.sendMessage(
      phoneNumber,
      "❌ No tengo el nuevo monto. Intenta de nuevo."
    );
    return;
  }
  const ok = await expenseService.updateAmount(
    pending.expenseId,
    pending.montoNuevo
  );
  await twilioService.sendMessage(
    phoneNumber,
    ok ?
      `✅ Listo: *${pending.descripcion}* ahora es ` +
        `${pending.moneda} ${pending.montoNuevo.toFixed(2)}.` :
      "❌ No pude actualizar el monto. Intenta de nuevo."
  );
}

/**
 * Handle bot commands (wallet, pendientes, historial)
 * @param {UserData} user - User data
 * @param {Account} account - Active account
 * @param {string} phoneNumber - User's phone number
 * @param {BotCommand} cmd - Parsed bot command
 * @return {Promise<void>} resolves when done
 */
async function handleBotCommand(
  user: UserData,
  account: Account,
  phoneNumber: string,
  cmd: BotCommand
): Promise<void> {
  const twilioService = new TwilioService();
  const accountService = new AccountService();
  const expenseService = new ExpenseService();
  const learningLog = new LearningLogService();
  // El web app es dueño del saldo/ledger (decisión "Opción A"). Por
  // WhatsApp solo se LEE el saldo canónico; ingreso/transferencia/
  // movimientos se gestionan en la app.
  const appHint = process.env.WEBAPP_URL ?
    `:\n${process.env.WEBAPP_URL}` :
    " (sección *Cuentas*).";

  try {
    switch (cmd.kind) {
    case "saldo": {
      await twilioService.sendMessage(
        phoneNumber,
        `🧮 *${account.nombre}*\n💱 ${account.moneda}\n` +
          `💰 Saldo: ${account.moneda} ${account.saldo.toFixed(2)}`
      );
      break;
    }
    case "saldos": {
      const all = await accountService.listCanonical(user.id);
      if (all.length === 0) {
        await twilioService.sendMessage(phoneNumber, "No tienes cuentas.");
        break;
      }
      const lines = all
        .map(
          (a) =>
            `• ${a.nombre}${a.isPrimary ? " (principal)" : ""}: ` +
            `${a.moneda} ${a.saldo.toFixed(2)}`
        )
        .join("\n");
      await twilioService.sendMessage(
        phoneNumber,
        `🧮 *Saldos por cuenta*\n\n${lines}`
      );
      break;
    }
    case "movimientos": {
      await twilioService.sendMessage(
        phoneNumber,
        "📜 El detalle de *movimientos* está en la app" +
        `${appHint}\n\n` +
        "Aquí puedo mostrarte tus gastos: escribe " +
        "*gastos de hoy*, *qué gasté esta semana* o *resumen*."
      );
      break;
    }
    case "ingreso": {
      await twilioService.sendMessage(
        phoneNumber,
        "💡 Los *ingresos* se registran desde la app" +
        `${appHint}\n\n` +
        "Por WhatsApp registro tus *gastos*. Para ver cuánto " +
        "tienes, escribe *saldo*."
      );
      break;
    }
    case "transferir": {
      await twilioService.sendMessage(
        phoneNumber,
        "💡 Las *transferencias entre cuentas* se hacen desde " +
        `la app${appHint}\n\n` +
        "Por WhatsApp registro gastos y te muestro tu *saldo* " +
        "(escribe *saldo* o *saldos*)."
      );
      break;
    }
    case "pendientes": {
      const pend = await expenseService.getPending(user.id, 15);
      if (pend.length === 0) {
        await twilioService.sendMessage(
          phoneNumber,
          "✅ No tienes gastos pendientes."
        );
        break;
      }
      const lines = pend
        .map((p) => {
          const flags = [
            p.needsClassification ? "sin clasificar" : null,
            p.needsReview ? "revisar método" : null,
            p.amountFlagged ? "monto atípico" : null,
          ]
            .filter(Boolean)
            .join(", ");
          return (
            `• ${p.id}\n  ${p.moneda} ${p.monto.toFixed(2)} — ` +
            `${p.descripcion} (${flags})`
          );
        })
        .join("\n");
      await twilioService.sendMessage(
        phoneNumber,
        `🗂️ *Pendientes*\n\n${lines}\n\n` +
          "Clasificar: clasificar <id> <categoria> [subcategoria]"
      );
      break;
    }
    case "clasificar": {
      const exp = await expenseService.getById(cmd.expenseId);
      if (!exp || exp.userId !== user.id) {
        await twilioService.sendMessage(
          phoneNumber,
          `❌ No encontré el gasto ${cmd.expenseId}.`
        );
        break;
      }
      const ok = await expenseService.updateClassification(
        cmd.expenseId,
        cmd.categoria,
        cmd.subcategoria ?? null
      );
      if (!ok) {
        await twilioService.sendMessage(
          phoneNumber,
          "❌ No pude actualizar la clasificación."
        );
        break;
      }
      await learningLog.append(user.id, {
        expenseId: cmd.expenseId,
        type: "user_correction",
        input: {
          raw: exp.descripcion,
          normalized: MessageParser.normalizeForMatching(exp.descripcion),
          channel: "text",
        },
        decision: {
          field: "categoria",
          value: cmd.categoria,
          source: "user_correction",
        },
      });
      await twilioService.sendMessage(
        phoneNumber,
        `✅ Reclasificado a *${cmd.categoria}*` +
          `${cmd.subcategoria ? ` / ${cmd.subcategoria}` : ""}. ` +
          "Lo recordaré."
      );
      break;
    }
    case "historial": {
      const recent = await learningLog.getRecent(user.id, 10);
      if (recent.length === 0) {
        await twilioService.sendMessage(
          phoneNumber,
          "Aún no tengo historial de aprendizaje tuyo."
        );
        break;
      }
      const lines = recent
        .map(
          (e) =>
            `• "${e.input.raw}" → ${e.decision.field}=` +
            `${e.decision.value} (${e.decision.source})`
        )
        .join("\n");
      await twilioService.sendMessage(
        phoneNumber,
        `🧠 *Tu historial reciente*\n\n${lines}\n\n` +
          "Escribe \"olvidar historial\" para borrarlo."
      );
      break;
    }
    case "olvidar_historial_prompt": {
      await twilioService.sendMessage(
        phoneNumber,
        "⚠️ Esto borrará *todo* lo que aprendí de tus " +
        "clasificaciones y no se puede deshacer.\n\n" +
        "Si estás seguro, responde: *olvidar historial confirmar*"
      );
      break;
    }
    case "olvidar_historial": {
      await learningLog.softDeleteAll(user.id);
      await twilioService.sendMessage(
        phoneNumber,
        "🗑️ Listo. Borré tu historial de aprendizaje."
      );
      break;
    }
    }
  } catch (error) {
    logger.error("Error handling bot command:", error);
    await twilioService.sendMessage(
      phoneNumber,
      "❌ Error al procesar el comando. Intenta de nuevo."
    );
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

  case "inicio": {
    await twilioService.sendMessage(
      phoneNumber,
      buildOnboarding(user.name)
    );
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
 * Twilio WhatsApp webhook. Valida X-Twilio-Signature y encola el mensaje
 * en whatsapp_queue (lo procesa processWhatsAppQueue vía onCreate).
 * Reemplaza el "Phase 1" externo. ROADMAP § A.3.
 */
export const twilioWebhook = onRequest(
  { secrets: [TWILIO_AUTH_TOKEN] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) {
      logger.error("twilioWebhook: TWILIO_AUTH_TOKEN no configurado");
      res.status(500).send("Server misconfigured");
      return;
    }
    if (!validateTwilioRequest(authToken, req)) {
      res.status(403).send("Invalid signature");
      return;
    }
    const body = (req.body || {}) as Record<string, string>;
    if (!body.From) {
      res.status(400).send("Missing From");
      return;
    }
    try {
      const doc = buildQueueDocFromTwilio(body);
      await admin
        .firestore()
        .collection("whatsapp_queue")
        .add({ ...doc, createdAt: Timestamp.now() });
      logger.info(
        `twilioWebhook: encolado ${doc.webhookBody.MessageSid}`
      );
      res.set("Content-Type", "text/xml");
      res.status(200).send("<Response></Response>");
    } catch (error) {
      logger.error("twilioWebhook: error encolando", error);
      res.status(500).send("Internal error");
    }
  }
);

/**
 * Export de gastos en CSV. Requiere `Authorization: Bearer <Firebase ID
 * token>`; exporta solo los expenses del uid del token. Query opcional
 * `?month=YYYY-MM`. Backend-shaped: habilita un dashboard/export sin abrir
 * `firestore.rules` a lectura directa. ROADMAP § A.4.
 */
export const exportExpenses = onRequest(async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).send("Method Not Allowed");
    return;
  }
  const authz = (req.headers.authorization as string) || "";
  const bearer = authz.match(/^Bearer (.+)$/);
  if (!bearer) {
    res.status(401).send("Missing bearer token");
    return;
  }
  let uid: string;
  try {
    const decoded = await admin.auth().verifyIdToken(bearer[1]);
    uid = decoded.uid;
  } catch (error) {
    logger.warn("exportExpenses: token inválido", error);
    res.status(401).send("Invalid token");
    return;
  }

  const monthQ =
    typeof req.query.month === "string" ? req.query.month : undefined;
  const month = monthQ && /^\d{4}-\d{2}$/.test(monthQ) ? monthQ : undefined;

  try {
    const expenseService = new ExpenseService();
    const rows = await expenseService.getForExport(uid, month);
    const headers = [
      "fecha",
      "monto",
      "moneda",
      "categoria",
      "subcategoria",
      "descripcion",
      "metodoPago",
      "voucherType",
      "accountId",
    ];
    const csv = toCsv(
      headers,
      rows.map((r) => [
        r.fecha,
        r.monto,
        r.moneda,
        r.categoria,
        r.subcategoria,
        r.descripcion,
        r.metodoPago,
        r.voucherType,
        r.accountId,
      ])
    );
    const fname = `gastos${month ? "-" + month : ""}.csv`;
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="${fname}"`);
    res.status(200).send(csv);
  } catch (error) {
    logger.error("exportExpenses: error", error);
    res.status(500).send("Internal error");
  }
});

/**
 * Health check endpoint
 */
export const healthCheck = onRequest((req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    service: "gastos-firebase-functions",
    features: {
      textParsing: true,
      imageParsing: true,
      audioParsing: true,
      categoryInference: true,
      userValidation: true,
      accounts: true,
      learningLog: true,
    },
  });
});

/**
 * Observabilidad: única superficie de alerta para fallos del pipeline.
 * Capta cualquier transición de `whatsapp_queue.status` → "failed" (sin
 * importar qué camino la causó) y emite un log estructurado estable.
 * Configurar en Cloud Logging una alert policy con el filtro:
 *   resource.type="cloud_run_revision"
 *   jsonPayload.event="whatsapp_queue_failed"
 *   severity=ERROR
 * Trade-off: se invoca en cada update del doc (pending/processing/…), pero
 * el guard retorna temprano salvo en la transición a failed (costo ~nulo).
 */
export const onWhatsAppQueueFailed = onDocumentUpdated(
  "whatsapp_queue/{queueId}",
  (event) => {
    const change = event.data;
    if (!change) return;
    const before = change.before.data() as
      | WhatsAppQueueDocument
      | undefined;
    const after = change.after.data() as
      | WhatsAppQueueDocument
      | undefined;
    if (!after) return;
    if (before?.status === "failed" || after.status !== "failed") return;

    logger.error("ALERT whatsapp_queue_failed", {
      event: "whatsapp_queue_failed",
      queueId: event.params.queueId,
      phoneNumber: after.phoneNumber,
      retryCount: after.retryCount,
      queueError: after.error ?? "unknown",
    });
  }
);
