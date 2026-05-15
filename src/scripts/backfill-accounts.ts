// Backfill idempotente — ROADMAP § F.6.
//
// 1. Por cada users/{uid} sin subcolección `accounts`: crea "Principal"
//    (isPrimary, PEN, saldo 0, saldoInicial 0).
// 2. Por cada expenses/{id} sin `accountId`: asigna el Principal de su user.
// 3. NO genera movements retroactivos: el ledger arranca en cero. El usuario
//    fija su saldo real con `ajustar saldo` o `ingreso ... apertura`.
//
// Correr dos veces es seguro (no-op si ya está migrado).
//
// Uso:
//   GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccount.json \
//     npm run backfill:accounts
// (o cualquier credencial ADC con permisos de Firestore del proyecto)

import * as admin from "firebase-admin";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const BATCH_LIMIT = 450;
const DEFAULT_MONEDA = "PEN";
const PRIMARY_NAME = "Principal";

interface Summary {
  usersProcessed: number;
  accountsCreated: number;
  expensesBackfilled: number;
  expensesAlreadyOk: number;
  expensesSkippedNoUser: number;
}

async function resolvePrincipalAccountId(
  db: FirebaseFirestore.Firestore,
  userId: string,
  summary: Summary
): Promise<string> {
  const accountsCol = db
    .collection("users")
    .doc(userId)
    .collection("accounts");
  const snap = await accountsCol.get();

  if (!snap.empty) {
    const primary = snap.docs.find((d) => d.data().isPrimary === true);
    if (primary) return primary.id;
    // Hay cuentas pero ninguna primary: promovemos la primera.
    const first = snap.docs[0];
    await first.ref.update({ isPrimary: true, updatedAt: Timestamp.now() });
    return first.id;
  }

  const now = Timestamp.now();
  const ref = accountsCol.doc();
  await ref.set({
    nombre: PRIMARY_NAME,
    isPrimary: true,
    moneda: DEFAULT_MONEDA,
    tipo: "personal",
    saldo: 0,
    saldoInicial: 0,
    createdAt: now,
    updatedAt: now,
  });
  summary.accountsCreated += 1;
  return ref.id;
}

async function main(): Promise<void> {
  admin.initializeApp();
  const db = getFirestore();

  const summary: Summary = {
    usersProcessed: 0,
    accountsCreated: 0,
    expensesBackfilled: 0,
    expensesAlreadyOk: 0,
    expensesSkippedNoUser: 0,
  };

  const principalByUser = new Map<string, string>();

  const usersSnap = await db.collection("users").get();
  for (const userDoc of usersSnap.docs) {
    const principalId = await resolvePrincipalAccountId(
      db,
      userDoc.id,
      summary
    );
    principalByUser.set(userDoc.id, principalId);
    summary.usersProcessed += 1;
  }

  const expensesSnap = await db.collection("expenses").get();
  let batch = db.batch();
  let pending = 0;

  for (const expDoc of expensesSnap.docs) {
    const data = expDoc.data();
    if (data.accountId) {
      summary.expensesAlreadyOk += 1;
      continue;
    }
    const userId: string | undefined = data.userId;
    const principalId = userId ?
      principalByUser.get(userId) :
      undefined;
    if (!principalId) {
      summary.expensesSkippedNoUser += 1;
      console.warn(
        `Expense ${expDoc.id} sin user resoluble (userId=${userId}) — skip`
      );
      continue;
    }
    batch.update(expDoc.ref, { accountId: principalId });
    pending += 1;
    summary.expensesBackfilled += 1;

    if (pending >= BATCH_LIMIT) {
      await batch.commit();
      batch = db.batch();
      pending = 0;
    }
  }

  if (pending > 0) {
    await batch.commit();
  }

  console.log("Backfill completado:", JSON.stringify(summary, null, 2));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Backfill falló:", err);
    process.exit(1);
  });
