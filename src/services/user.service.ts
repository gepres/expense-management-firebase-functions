import { getFirestore } from "firebase-admin/firestore";
import * as functions from "firebase-functions/v1";
import { UserData } from "../types";

export class UserService {
  private db: FirebaseFirestore.Firestore;

  constructor() {
    this.db = getFirestore();
  }

  async findByWhatsAppPhone(phoneNumber: string): Promise<UserData | null> {
    try {
      const normalizedPhone = phoneNumber.replace("whatsapp:", "").trim();

      const usersSnapshot = await this.db
        .collection("users")
        .where("whatsappPhone", "==", normalizedPhone)
        .limit(1)
        .get();

      if (usersSnapshot.empty) {
        functions.logger.warn(`User not found for phone: ${normalizedPhone}`);
        return null;
      }

      const userDoc = usersSnapshot.docs[0];
      return {
        id: userDoc.id,
        ...userDoc.data(),
      } as UserData;
    } catch (error) {
      functions.logger.error("Error finding user by WhatsApp phone:", error);
      return null;
    }
  }

  async updateWhatsAppPhone(userId: string, phoneNumber: string): Promise<boolean> {
    try {
      await this.db.collection("users").doc(userId).update({
        whatsappPhone: phoneNumber,
        whatsappLinkedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      functions.logger.info(`WhatsApp phone updated for user ${userId}`);
      return true;
    } catch (error) {
      functions.logger.error("Error updating WhatsApp phone:", error);
      return false;
    }
  }

  async unlinkWhatsAppPhone(userId: string): Promise<boolean> {
    try {
      await this.db.collection("users").doc(userId).update({
        whatsappPhone: null,
        whatsappLinkedAt: null,
        updatedAt: new Date().toISOString(),
      });

      functions.logger.info(`WhatsApp phone unlinked for user ${userId}`);
      return true;
    } catch (error) {
      functions.logger.error("Error unlinking WhatsApp phone:", error);
      return false;
    }
  }

  async getUserById(userId: string): Promise<UserData | null> {
    try {
      const userDoc = await this.db.collection("users").doc(userId).get();

      if (!userDoc.exists) {
        return null;
      }

      return {
        id: userDoc.id,
        ...userDoc.data(),
      } as UserData;
    } catch (error) {
      functions.logger.error("Error getting user by ID:", error);
      return null;
    }
  }
}
