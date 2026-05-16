import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";

const ONBOARDING_DOC_ID = "onboarding";

// Marca "ya saludé a este usuario" en una colección propia del bot
// (`users/{uid}/sessions/onboarding`, mismo patrón que la sesión wsp de
// AccountService). El web app es el dueño de `users` pero el bot ya gestiona
// `users/{uid}/sessions/*`, así que esto no invade su modelo.
export class OnboardingService {
  private db: FirebaseFirestore.Firestore;

  constructor() {
    this.db = getFirestore();
  }

  private doc(userId: string): FirebaseFirestore.DocumentReference {
    return this.db
      .collection("users")
      .doc(userId)
      .collection("sessions")
      .doc(ONBOARDING_DOC_ID);
  }

  /**
   * Reclama el primer contacto de forma idempotente y exactamente-una-vez.
   * `create()` falla si el doc ya existe → un reintento de Twilio o un
   * duplicado en la cola NO vuelve a saludar.
   * @param {string} userId - id del usuario.
   * @return {Promise<boolean>} true solo si este proceso creó el marcador
   *   (primer contacto real); false si ya existía o hubo error (no saludar).
   */
  async tryClaimFirstContact(userId: string): Promise<boolean> {
    const ref = this.doc(userId);
    try {
      const snap = await ref.get();
      if (snap.exists) return false;
      await ref.create({ greetedAt: Timestamp.now() });
      return true;
    } catch (error) {
      // ALREADY_EXISTS (carrera entre get y create) u otro error:
      // ante la duda, no saludar (mejor callar que spamear).
      logger.warn("OnboardingService: no se pudo reclamar primer contacto", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
