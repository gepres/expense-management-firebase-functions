import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { Account, CreateAccountInput, WhatsAppSession } from "../types";

const DEFAULT_PRIMARY_NAME = "Principal";
const DEFAULT_MONEDA = "PEN";
const SESSION_TTL_MINUTES_DEFAULT = 30;
const SESSION_DOC_ID = "whatsapp";

export class AccountService {
  private db: FirebaseFirestore.Firestore;

  constructor() {
    this.db = getFirestore();
  }

  private accountsCol(userId: string): FirebaseFirestore.CollectionReference {
    return this.db.collection("users").doc(userId).collection("accounts");
  }

  private sessionDoc(userId: string): FirebaseFirestore.DocumentReference {
    return this.db
      .collection("users")
      .doc(userId)
      .collection("sessions")
      .doc(SESSION_DOC_ID);
  }

  async getById(userId: string, accountId: string): Promise<Account | null> {
    try {
      const snap = await this.accountsCol(userId).doc(accountId).get();
      if (!snap.exists) return null;
      return { id: snap.id, ...(snap.data() as Omit<Account, "id">) };
    } catch (error) {
      logger.error("Error fetching account by id:", error);
      return null;
    }
  }

  async listByUser(userId: string): Promise<Account[]> {
    try {
      const snap = await this.accountsCol(userId).get();
      return snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Account, "id">),
      }));
    } catch (error) {
      logger.error("Error listing accounts for user:", error);
      return [];
    }
  }

  async getPrimary(userId: string): Promise<Account | null> {
    try {
      const snap = await this.accountsCol(userId)
        .where("isPrimary", "==", true)
        .limit(1)
        .get();
      if (snap.empty) return null;
      const doc = snap.docs[0];
      return { id: doc.id, ...(doc.data() as Omit<Account, "id">) };
    } catch (error) {
      logger.error("Error fetching primary account:", error);
      return null;
    }
  }

  async findByNombre(userId: string, nombre: string): Promise<Account | null> {
    try {
      const normalized = nombre.trim().toLowerCase();
      const all = await this.listByUser(userId);
      return all.find((a) => a.nombre.trim().toLowerCase() === normalized) ?? null;
    } catch (error) {
      logger.error("Error finding account by nombre:", error);
      return null;
    }
  }

  // Crea una cuenta. Si `isPrimary` es true y ya existe otra primary, el
  // caller debe llamar a `setPrimary` después para mantener la invariante
  // de "exactamente una principal". No escribe el movement de apertura: si
  // `saldoInicial > 0`, el caller persiste un Movement "ingreso" con
  // metadata.aperturaInicial para no romper la coherencia ledger ↔ saldo.
  async createAccount(
    userId: string,
    input: CreateAccountInput
  ): Promise<Account | null> {
    try {
      const now = Timestamp.now();
      const saldoInicial = input.saldoInicial ?? 0;
      const docRef = this.accountsCol(userId).doc();
      // Firestore rechaza `undefined`: omitir opcionales ausentes.
      const account: Record<string, unknown> = {
        nombre: input.nombre,
        isPrimary: input.isPrimary ?? false,
        moneda: input.moneda,
        saldo: saldoInicial,
        saldoInicial,
        createdAt: now,
        updatedAt: now,
      };
      if (input.tipo !== undefined) account.tipo = input.tipo;
      if (input.saldoMinimoAlerta !== undefined) {
        account.saldoMinimoAlerta = input.saldoMinimoAlerta;
      }
      await docRef.set(account);
      logger.info(
        `Account created for user ${userId}: ${docRef.id} (${input.nombre})`
      );
      return { id: docRef.id, ...(account as Omit<Account, "id">) };
    } catch (error) {
      logger.error("Error creating account:", error);
      return null;
    }
  }

  // Marca `accountId` como primary y desmarca las otras del usuario.
  // Transacción Firestore para mantener la invariante.
  async setPrimary(userId: string, accountId: string): Promise<boolean> {
    try {
      await this.db.runTransaction(async (tx) => {
        const allSnap = await tx.get(this.accountsCol(userId));
        for (const doc of allSnap.docs) {
          tx.update(doc.ref, {
            isPrimary: doc.id === accountId,
            updatedAt: Timestamp.now(),
          });
        }
      });
      return true;
    } catch (error) {
      logger.error("Error setting primary account:", error);
      return false;
    }
  }

  // Resolución de cuenta activa para una invocación del bot. Orden
  // (ROADMAP § B.1): sesión WhatsApp no expirada → isPrimary → primera
  // cuenta (se marca primary lazy) → crear "Principal" PEN saldo=0.
  async resolveActiveAccount(userId: string): Promise<Account> {
    const session = await this.getSessionAccount(userId);
    if (session) return session;

    const primary = await this.getPrimary(userId);
    if (primary) return primary;

    const all = await this.listByUser(userId);
    if (all.length > 0) {
      const first = all[0];
      await this.setPrimary(userId, first.id);
      return { ...first, isPrimary: true };
    }

    const created = await this.createAccount(userId, {
      nombre: DEFAULT_PRIMARY_NAME,
      moneda: DEFAULT_MONEDA,
      isPrimary: true,
      tipo: "personal",
    });
    if (!created) {
      throw new Error(`Could not initialize primary account for user ${userId}`);
    }
    logger.info(
      `Lazy-created primary account for user ${userId}: ${created.id}`
    );
    return created;
  }

  async getSessionAccount(userId: string): Promise<Account | null> {
    try {
      const snap = await this.sessionDoc(userId).get();
      if (!snap.exists) return null;
      const data = snap.data() as WhatsAppSession;
      if (data.expiresAt.toMillis() < Date.now()) {
        return null;
      }
      return this.getById(userId, data.activeAccountId);
    } catch (error) {
      logger.error("Error reading WhatsApp session:", error);
      return null;
    }
  }

  async setSessionAccount(
    userId: string,
    accountId: string,
    ttlMinutes: number = SESSION_TTL_MINUTES_DEFAULT
  ): Promise<boolean> {
    try {
      const now = Date.now();
      const session: WhatsAppSession = {
        activeAccountId: accountId,
        setAt: Timestamp.fromMillis(now),
        expiresAt: Timestamp.fromMillis(now + ttlMinutes * 60 * 1000),
      };
      await this.sessionDoc(userId).set(session);
      return true;
    } catch (error) {
      logger.error("Error setting WhatsApp session:", error);
      return false;
    }
  }

  async clearSessionAccount(userId: string): Promise<boolean> {
    try {
      await this.sessionDoc(userId).delete();
      return true;
    } catch (error) {
      logger.error("Error clearing WhatsApp session:", error);
      return false;
    }
  }
}
