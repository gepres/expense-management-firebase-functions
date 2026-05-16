import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { PendingAction } from "../types";

const DOC_ID = "pending_action";
const TTL_MINUTES_DEFAULT = 10;

// Estado de conversación corto: una acción que espera "sí/no". Mismo
// patrón que la sesión wsp / onboarding (users/{uid}/sessions/*). TTL
// para no dejar al usuario "atrapado" en una confirmación vieja.
export class PendingActionService {
  private db: FirebaseFirestore.Firestore;

  constructor() {
    this.db = getFirestore();
  }

  private doc(userId: string): FirebaseFirestore.DocumentReference {
    return this.db
      .collection("users")
      .doc(userId)
      .collection("sessions")
      .doc(DOC_ID);
  }

  async set(
    userId: string,
    action: Omit<PendingAction, "setAt" | "expiresAt">,
    ttlMinutes: number = TTL_MINUTES_DEFAULT
  ): Promise<void> {
    try {
      const now = Date.now();
      const payload: PendingAction = {
        ...action,
        setAt: Timestamp.fromMillis(now),
        expiresAt: Timestamp.fromMillis(now + ttlMinutes * 60 * 1000),
      };
      await this.doc(userId).set(payload);
    } catch (error) {
      logger.error("PendingActionService.set error:", error);
    }
  }

  // Devuelve la acción vigente o null (inexistente o expirada).
  async get(userId: string): Promise<PendingAction | null> {
    try {
      const snap = await this.doc(userId).get();
      if (!snap.exists) return null;
      const data = snap.data() as PendingAction;
      if (data.expiresAt.toMillis() < Date.now()) {
        await this.clear(userId);
        return null;
      }
      return data;
    } catch (error) {
      logger.error("PendingActionService.get error:", error);
      return null;
    }
  }

  async clear(userId: string): Promise<void> {
    try {
      await this.doc(userId).delete();
    } catch (error) {
      logger.error("PendingActionService.clear error:", error);
    }
  }
}
