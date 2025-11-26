import { Timestamp } from "firebase-admin/firestore";

export interface WhatsAppQueueDocument {
  phoneNumber: string;
  message: string;
  webhookBody: TwilioWebhookBody;
  status: "pending" | "processing" | "completed" | "failed";
  createdAt: Timestamp;
  processedAt?: Timestamp;
  error?: string;
  retryCount: number;
}

export interface TwilioWebhookBody {
  MessageSid: string;
  From: string;
  To?: string;
  Body: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
  ProfileName?: string;
  WaId?: string;
  SmsMessageSid?: string;
  NumSegments?: string;
  SmsSid?: string;
  SmsStatus?: string;
  ApiVersion?: string;
  AccountSid?: string;
}

export interface ExpenseData {
  monto: number;
  categoria: string;
  descripcion: string;
  fecha: string;
  metodoPago: string;
  moneda: string;
  subcategoria: string | null;
  recurrente: boolean;
  reimbursementStatus: "pending" | "approved" | "rejected";
  userId: string;
  voucherType: string;
}

export interface AnthropicResponse {
  success: boolean;
  expenseData?: ExpenseData;
  error?: string;
  rawResponse?: string;
}

export interface ReceiptExtractionResult {
  monto: number;
  comercio: string;
  descripcion: string;
  fecha: string;
  metodoPago: string;
  moneda: string;
  categoria: string;
  subcategoria: string | null;
}

export interface UserData {
  id: string;
  name?: string;
  email?: string;
  whatsappPhone?: string;
  whatsappLinkedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Category {
  id: string;
  nombre: string;
  subcategorias?: Subcategory[];
}

export interface Subcategory {
  id: string;
  nombre: string;
  suggestions_ideas?: string[];
}

export interface PaymentMethod {
  id: string;
  nombre: string;
}
