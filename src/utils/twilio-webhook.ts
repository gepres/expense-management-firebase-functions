import type { Request } from "firebase-functions/v2/https";
import twilio from "twilio";
import * as logger from "firebase-functions/logger";
import { TwilioWebhookBody, WhatsAppQueueDocument } from "../types";
import { MessageParser } from "./message-parser";

type TwilioParams = Record<string, string>;

// Reconstruye la URL pública exacta que Twilio firmó. Detrás de Cloud Run
// hay proxy: usar x-forwarded-*. Si Twilio apunta a un dominio custom, el
// host debe coincidir o la validación fallará (gotcha conocido).
function buildRequestUrl(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
  const host =
    (req.headers["x-forwarded-host"] as string) ||
    (req.headers.host as string) ||
    "";
  const path = req.originalUrl || req.url || "";
  return `${proto}://${host}${path}`;
}

export function validateTwilioRequest(
  authToken: string,
  req: Request
): boolean {
  const signature = req.headers["x-twilio-signature"];
  if (!signature || typeof signature !== "string") {
    logger.warn("twilioWebhook: falta X-Twilio-Signature");
    return false;
  }
  const url = buildRequestUrl(req);
  const params = (req.body || {}) as TwilioParams;
  const ok = twilio.validateRequest(authToken, signature, url, params);
  if (!ok) {
    logger.warn("twilioWebhook: firma inválida", { url });
  }
  return ok;
}

// Mapeo puro de los params del webhook al documento de la cola.
// `createdAt` lo agrega el caller (Timestamp.now()).
export function buildQueueDocFromTwilio(
  body: TwilioParams
): Omit<WhatsAppQueueDocument, "createdAt"> {
  const from = body.From || "";
  const webhookBody: TwilioWebhookBody = {
    MessageSid: body.MessageSid || "",
    From: from,
    Body: body.Body || "",
  };

  const optional: Array<[keyof TwilioWebhookBody, string | undefined]> = [
    ["To", body.To],
    ["NumMedia", body.NumMedia],
    ["MediaUrl0", body.MediaUrl0],
    ["MediaContentType0", body.MediaContentType0],
    ["ProfileName", body.ProfileName],
    ["WaId", body.WaId],
    ["SmsMessageSid", body.SmsMessageSid],
    ["NumSegments", body.NumSegments],
    ["SmsSid", body.SmsSid],
    ["SmsStatus", body.SmsStatus],
    ["ApiVersion", body.ApiVersion],
    ["AccountSid", body.AccountSid],
  ];
  const wb = webhookBody as unknown as Record<string, string>;
  for (const [key, value] of optional) {
    if (value !== undefined) {
      wb[key as string] = value;
    }
  }

  return {
    phoneNumber: MessageParser.normalizePhoneNumber(from),
    message: body.Body || "",
    webhookBody,
    status: "pending",
    retryCount: 0,
  };
}
