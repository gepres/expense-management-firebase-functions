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

export type MatchedLevel =
  | "suggestion"
  | "subcategory"
  | "category"
  | "history"
  | "user_correction"
  | "default";

export type CurrencySource = "text" | "account" | "default";
export type DateSource = "regex" | "llm" | "message" | "default";
export type PaymentMethodSource = "text" | "inferred" | "fallback";

export interface ExpenseAuditFields {
  matchedTerm?: string | null;
  matchedLevel?: MatchedLevel;
  currencySource?: CurrencySource;
  dateSource?: DateSource;
  paymentMethodSource?: PaymentMethodSource;
}

export interface ExpenseData extends ExpenseAuditFields {
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
  // Fase "validaciones + clasificación inteligente":
  accountId?: string;
  needsClassification?: boolean;
  needsReview?: boolean;
  amountFlagged?: boolean;
  messageSid?: string;
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

export type BotCommand =
  | { kind: "saldo" }
  | { kind: "saldos" }
  | { kind: "movimientos" }
  | { kind: "historial" }
  | { kind: "olvidar_historial" }
  | { kind: "pendientes" }
  | { kind: "ingreso"; monto: number; descripcion: string }
  | { kind: "transferir"; monto: number; cuenta: string }
  | {
      kind: "clasificar";
      expenseId: string;
      categoria: string;
      subcategoria?: string;
    };

// ─────────────────────────────────────────────────────────────────────────
// Wallet: accounts + movements (ledger)
// Decisiones cerradas 2026-05-14 — ver docs/ROADMAP.md § F.
// `accounts.saldo` es caché denormalizado; fuente de verdad: movements.
// ─────────────────────────────────────────────────────────────────────────

export type AccountTipo = "personal" | "negocio" | "compartida";

export interface Account {
  id: string;
  nombre: string;
  isPrimary: boolean;
  moneda: string;
  tipo?: AccountTipo;
  saldo: number;
  saldoInicial: number;
  saldoMinimoAlerta?: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface CreateAccountInput {
  nombre: string;
  moneda: string;
  isPrimary?: boolean;
  tipo?: AccountTipo;
  saldoInicial?: number;
  saldoMinimoAlerta?: number;
}

export type MovementType =
  | "gasto"
  | "ingreso"
  | "transferencia_in"
  | "transferencia_out"
  | "ajuste"
  | "reversion";

export interface MovementMetadata {
  aperturaInicial?: boolean;
  ajusteManual?: boolean;
}

export interface Movement {
  id: string;
  accountId: string;
  tipo: MovementType;
  monto: number;
  signoEfectivo: -1 | 1;
  expenseId?: string;
  transferPairId?: string;
  descripcion: string;
  fecha: Timestamp;
  saldoAnterior: number;
  saldoNuevo: number;
  metadata?: MovementMetadata;
  createdAt: Timestamp;
}

export interface MovementInput {
  accountId: string;
  tipo: MovementType;
  monto: number;
  expenseId?: string;
  transferPairId?: string;
  descripcion: string;
  fecha: Timestamp;
  metadata?: MovementMetadata;
}

export interface WhatsAppSession {
  activeAccountId: string;
  setAt: Timestamp;
  expiresAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────
// Learning log: bitácora append-only de decisiones por usuario.
// ROADMAP § G.2.
// ─────────────────────────────────────────────────────────────────────────

export type LearningLogType =
  | "classification"
  | "currency"
  | "date"
  | "payment"
  | "amount"
  | "user_correction";

export type LearningSource =
  | "regex"
  | "llm"
  | "history"
  | "user_correction"
  | "default";

export type InputChannel = "text" | "image" | "audio";

export interface LearningLogInput {
  raw: string;
  normalized: string;
  channel: InputChannel;
}

export interface LearningLogDecision {
  field: string;
  value: string | number;
  source: LearningSource;
  matchedTerm?: string;
  confidence?: number;
}

export interface LearningLogFeedback {
  correctedValue: string | number;
  at: Timestamp;
  via: "wsp_command" | "app_ui";
}

export interface LearningLogEntry {
  id?: string;
  expenseId?: string;
  type: LearningLogType;
  input: LearningLogInput;
  decision: LearningLogDecision;
  userFeedback?: LearningLogFeedback;
  tokens?: string[];
  createdAt: Timestamp;
  deletedAt?: Timestamp;
}

export interface LearningLogEntryInput {
  expenseId?: string;
  type: LearningLogType;
  input: LearningLogInput;
  decision: LearningLogDecision;
}
