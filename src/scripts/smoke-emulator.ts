// Smoke test sobre el EMULADOR: siembra datos canónicos, encola mensajes
// que cubren los caminos críticos/tocados (registro de gasto, consultas,
// saldo/saldos canónico, comandos retirados ingreso/transferir/movimientos,
// ayuda, confirmación de olvidar, y dead-end sin cuenta canónica) y
// verifica el estado resultante en Firestore.
//
// Uso (one-shot, levanta y tumba el emulador solo):
//   npm run smoke
// Requisitos:
//   - `.secret.local` con las 5 claves (Twilio puede ser dummy: el envío
//     falla silencioso en emulador y el flujo igual cierra el queue doc).
//   - Usa teléfonos FALSOS (+5190000000x): Twilio los rechaza, no se
//     manda WhatsApp real.
// Nota: el emulador de Firestore NO exige índices compuestos; este smoke
// valida lógica/flujo, no el índice de prod (ese ya se verificó aparte).

import * as admin from "firebase-admin";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

process.env.FIRESTORE_EMULATOR_HOST =
  process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";

const PROJECT_ID = process.env.GCLOUD_PROJECT || "expense-app-gepres";
const UID_OK = "smoke-user-ok";
const UID_NOACC = "smoke-user-noacc";
const PHONE_OK = "+51900000001";
const PHONE_NOACC = "+51900000002";
const POLL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

interface Case {
  label: string;
  phone: string;
  text: string;
  expectStatus: "completed" | "failed";
  errorIncludes?: string;
  expectExpense?: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let sidSeq = 0;
const nextSid = (): string => `SM-smoke-${Date.now()}-${sidSeq++}`;

async function deleteWhere(
  db: FirebaseFirestore.Firestore,
  col: string,
  field: string,
  val: string
): Promise<void> {
  const snap = await db.collection(col).where(field, "==", val).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

async function seed(db: FirebaseFirestore.Firestore): Promise<void> {
  const now = Timestamp.now();

  // Limpieza idempotente (corridas repetidas).
  await Promise.all([
    deleteWhere(db, "whatsapp_queue", "phoneNumber", PHONE_OK),
    deleteWhere(db, "whatsapp_queue", "phoneNumber", PHONE_NOACC),
    deleteWhere(db, "expenses", "userId", UID_OK),
    deleteWhere(db, "accounts", "userId", UID_OK),
  ]);
  await db
    .collection("users").doc(UID_OK)
    .collection("sessions").doc("onboarding").delete()
    .catch(() => undefined);
  await db
    .collection("users").doc(UID_NOACC)
    .collection("sessions").doc("onboarding").delete()
    .catch(() => undefined);

  // Usuario OK + cuenta CANÓNICA (top-level `accounts`, modelo web app).
  await db.collection("users").doc(UID_OK).set({
    name: "Smoke OK",
    whatsappPhone: PHONE_OK,
    whatsappLinkedAt: now.toDate().toISOString(),
  });
  await db.collection("accounts").doc(`${UID_OK}-acc`).set({
    userId: UID_OK,
    name: "Principal",
    isDefault: true,
    currency: "PEN",
    bankBalance: 800,
    cashBalance: 200,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .collection("users").doc(UID_OK)
    .collection("categories").doc("comida")
    .set({
      nombre: "Comida",
      subcategorias: [
        {
          id: "restaurantes",
          nombre: "Restaurantes",
          suggestions_ideas: ["almuerzo", "cena"],
        },
      ],
    });
  // learning_log sembrado → onboarding suprimido para UID_OK (así cada
  // mensaje ejecuta su handler real, no la bienvenida).
  await db
    .collection("users").doc(UID_OK)
    .collection("learning_log").doc("seed")
    .set({
      type: "classification",
      input: { raw: "seed", normalized: "seed", channel: "text" },
      decision: { field: "categoria", value: "comida", source: "regex" },
      tokens: ["seed"],
      createdAt: now,
    });
  // Gastos de HOY pre-sembrados (para consultas deterministas).
  for (const [monto, desc] of [[30, "desayuno"], [20, "micro"]] as const) {
    await db.collection("expenses").add({
      userId: UID_OK,
      accountId: `${UID_OK}-acc`,
      monto,
      categoria: "comida",
      subcategoria: null,
      descripcion: desc,
      fecha: now,
      metodoPago: "efectivo",
      moneda: "PEN",
      recurrente: false,
      reimbursementStatus: "pending",
      voucherType: "boleta",
      createdAt: now,
      updatedAt: now,
    });
  }

  // Usuario SIN cuenta canónica → dead-end guiado.
  await db.collection("users").doc(UID_NOACC).set({
    name: "Smoke NoAcc",
    whatsappPhone: PHONE_NOACC,
    whatsappLinkedAt: now.toDate().toISOString(),
  });
}

async function main(): Promise<void> {
  admin.initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore();
  await seed(db);

  const cases: Case[] = [
    {
      label: "registrar gasto (regex)",
      phone: PHONE_OK,
      text: "50 almuerzo",
      expectStatus: "completed",
      expectExpense: true,
    },
    { label: "consulta: cuánto gasté hoy", phone: PHONE_OK,
      text: "cuanto gaste hoy", expectStatus: "completed" },
    { label: "consulta: gastos de hoy", phone: PHONE_OK,
      text: "gastos de hoy", expectStatus: "completed" },
    { label: "saldos (listCanonical)", phone: PHONE_OK,
      text: "saldos", expectStatus: "completed" },
    { label: "saldo (canónico)", phone: PHONE_OK,
      text: "saldo", expectStatus: "completed" },
    { label: "ingreso → deriva a app", phone: PHONE_OK,
      text: "ingreso 100 sueldo", expectStatus: "completed" },
    { label: "transferir → deriva a app", phone: PHONE_OK,
      text: "transferir 50 a ahorros", expectStatus: "completed" },
    { label: "movimientos → deriva a app", phone: PHONE_OK,
      text: "movimientos", expectStatus: "completed" },
    { label: "ayuda saldo", phone: PHONE_OK,
      text: "ayuda saldo", expectStatus: "completed" },
    { label: "olvidar historial (confirm prompt)", phone: PHONE_OK,
      text: "olvidar historial", expectStatus: "completed" },
    {
      label: "dead-end sin cuenta canónica",
      phone: PHONE_NOACC,
      text: "20 pan",
      expectStatus: "completed",
      errorIncludes: "no canonical account",
    },
  ];

  // Encolar secuencialmente (mismo phone procesa de a uno por el marcador
  // de onboarding/idempotencia; el orden no afecta las aserciones).
  const ids: string[] = [];
  for (const c of cases) {
    const ref = await db.collection("whatsapp_queue").add({
      phoneNumber: c.phone,
      message: c.text,
      webhookBody: {
        MessageSid: nextSid(),
        From: `whatsapp:${c.phone}`,
        Body: c.text,
        NumMedia: "0",
      },
      status: "pending",
      retryCount: 0,
      createdAt: Timestamp.now(),
    });
    ids.push(ref.id);
  }
  console.log(`Encolados ${ids.length} mensajes. Esperando proceso…`);

  // Poll hasta que todos salgan de pending/processing o timeout.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const finalStatus = new Map<string, { status: string; error?: string }>();
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    let pending = 0;
    for (const id of ids) {
      const snap = await db.collection("whatsapp_queue").doc(id).get();
      const d = snap.data() || {};
      const st = String(d.status || "pending");
      if (st === "pending" || st === "processing") {
        pending++;
      } else {
        finalStatus.set(id, { status: st, error: d.error });
      }
    }
    if (pending === 0) break;
  }

  // Evaluar.
  const expensesOk = await db
    .collection("expenses")
    .where("userId", "==", UID_OK)
    .where("monto", "==", 50)
    .get();

  let failures = 0;
  console.log("\n──────── RESULTADOS ────────");
  cases.forEach((c, i) => {
    const r = finalStatus.get(ids[i]);
    const st = r?.status ?? "TIMEOUT";
    const errs: string[] = [];
    if (st !== c.expectStatus) {
      errs.push(`status=${st} (esperado ${c.expectStatus})`);
    }
    if (c.errorIncludes && !(r?.error || "").includes(c.errorIncludes)) {
      errs.push(`error="${r?.error ?? ""}" no incluye "${c.errorIncludes}"`);
    }
    if (c.expectExpense && expensesOk.empty) {
      errs.push("no se creó el expense (monto 50)");
    }
    const ok = errs.length === 0;
    if (!ok) failures++;
    console.log(
      `${ok ? "✅" : "❌"} ${c.label} → ${st}` +
        (r?.error ? ` [${r.error}]` : "") +
        (ok ? "" : `\n     ${errs.join("; ")}`)
    );
  });
  console.log("────────────────────────────");
  console.log(
    `${cases.length - failures}/${cases.length} OK` +
      (failures ?
        "\n⚠️ Si TODO falló con status=failed: falta `.secret.local` " +
          "(TwilioService no arranca sin TWILIO_ACCOUNT_SID/AUTH_TOKEN)." :
        "")
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke falló (¿emulador arriba? ¿lib/ compilado?):", err);
  process.exit(1);
});
