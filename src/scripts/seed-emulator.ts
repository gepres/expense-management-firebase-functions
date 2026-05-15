// Siembra datos de prueba en el EMULADOR de Firestore y, opcionalmente,
// encola un mensaje para disparar processWhatsAppQueue.
//
// Uso (con el emulador corriendo):
//   npm run seed:emulator
//   npm run seed:emulator -- --enqueue "50 almuerzo"
//
// Targetea el emulador automáticamente (FIRESTORE_EMULATOR_HOST).
// NUNCA escribe en producción: si no hay emulador, falla la conexión.

import * as admin from "firebase-admin";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const PROJECT_ID = process.env.GCLOUD_PROJECT || "expense-app-gepres";
const TEST_UID = "test-user";
const TEST_PHONE = "+51999999999";

async function main(): Promise<void> {
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();
  const now = Timestamp.now();

  const userRef = db.collection("users").doc(TEST_UID);
  await userRef.set({
    name: "Test User",
    email: "test@example.com",
    whatsappPhone: TEST_PHONE,
    whatsappLinkedAt: now.toDate().toISOString(),
  });

  await userRef.collection("accounts").doc("principal").set({
    nombre: "Principal",
    isPrimary: true,
    moneda: "PEN",
    tipo: "personal",
    saldo: 0,
    saldoInicial: 0,
    createdAt: now,
    updatedAt: now,
  });

  await userRef.collection("categories").doc("comida").set({
    nombre: "Comida",
    subcategorias: [
      {
        id: "restaurantes",
        nombre: "Restaurantes",
        suggestions_ideas: ["almuerzo", "cena", "pizza", "pollo a la brasa"],
      },
      {
        id: "delivery",
        nombre: "Delivery",
        suggestions_ideas: ["pedidos ya", "rappi", "didi food"],
      },
    ],
  });

  await userRef.collection("payment_methods").doc("yape").set({
    nombre: "Yape",
  });

  console.log(
    `Seed OK en emulador (${process.env.FIRESTORE_EMULATOR_HOST}): ` +
      `user=${TEST_UID} phone=${TEST_PHONE}`
  );

  const enqueueIdx = process.argv.indexOf("--enqueue");
  if (enqueueIdx !== -1 && process.argv.length > enqueueIdx + 1) {
    // Junta todo lo que sigue (por si el shell separó por espacios) y
    // limpia los `^` que cmd/PowerShell inyecta al escapar comillas.
    const message = process.argv
      .slice(enqueueIdx + 1)
      .join(" ")
      .replace(/\^/g, "")
      .trim();
    const ref = await db.collection("whatsapp_queue").add({
      phoneNumber: TEST_PHONE,
      message,
      webhookBody: {
        MessageSid: `SM-seed-${Date.now()}`,
        From: `whatsapp:${TEST_PHONE}`,
        Body: message,
        NumMedia: "0",
      },
      status: "pending",
      retryCount: 0,
      createdAt: Timestamp.now(),
    });
    console.log(
      `Encolado whatsapp_queue/${ref.id} → "${message}". ` +
        "Revisa los logs del emulador de Functions."
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seed falló (¿está corriendo el emulador?):", err);
    process.exit(1);
  });
