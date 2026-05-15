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

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv.length > i + 1 ?
    process.argv[i + 1] :
    undefined;
}

// Para probar con WhatsApp real, el user sembrado debe tener TU número en
// E.164. Override: `--phone "+51987654321"` o env SEED_PHONE. `--phone`
// debe ir ANTES de `--enqueue` (lo que sigue a --enqueue se toma como msg).
const TEST_PHONE = (
  flagValue("--phone") ||
  process.env.SEED_PHONE ||
  "+51999999999"
).trim();

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

  // "taxi" NO está en nombres/suggestions a propósito: así los pasos
  // 1–3 (match exacto) fallan y "30 taxi" solo resuelve vía el paso 5
  // (LLM acotado), que es lo que se quiere validar.
  await userRef.collection("categories").doc("transporte").set({
    nombre: "Transporte",
    subcategorias: [
      {
        id: "combustible",
        nombre: "Combustible",
        suggestions_ideas: ["gasolina", "grifo", "petroleo"],
      },
      {
        id: "publico",
        nombre: "Transporte público",
        suggestions_ideas: ["pasaje", "metropolitano", "combi"],
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
