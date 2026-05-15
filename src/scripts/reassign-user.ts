// Reasigna la propiedad de datos de un usuario a otro y mueve el
// whatsappPhone. Resuelve el problema de identidad: el WhatsApp quedó
// enganchado a un users/{FROM} distinto del users/{TO} con el que el
// usuario entra al web app, así que el bot guardaba gastos bajo FROM y
// el web app (que consulta por TO) no los veía.
//
// Hace, de FROM → TO:
//   1. expenses where userId == FROM  → userId = TO
//      (por defecto SOLO los creados por el bot: con `messageSid`.
//       --all-expenses incluye todos los de FROM.)
//   2. (opcional, --include-learning) copia users/{FROM}/learning_log
//      → users/{TO}/learning_log (no borra el origen).
//   3. whatsappPhone: lo limpia en users/{FROM} y lo setea en users/{TO}
//      (--skip-phone para omitir y usar el flujo de link del web app).
//
// DRY-RUN por defecto: solo imprime lo que haría. Aplica con --apply.
// Idempotente: correrlo dos veces tras aplicar es no-op.
//
// Uso:
//   GOOGLE_APPLICATION_CREDENTIALS=/ruta/serviceAccount.json \
//     npm run reassign:user -- --from <UID_FROM> --to <UID_TO> \
//       [--all-expenses] [--include-learning] [--skip-phone] [--apply]

import * as admin from "firebase-admin";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const BATCH_LIMIT = 450;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv.length > i + 1 ?
    process.argv[i + 1] :
    undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const FROM = flag("--from");
  const TO = flag("--to");
  const apply = has("--apply");
  const allExpenses = has("--all-expenses");
  const includeLearning = has("--include-learning");
  const skipPhone = has("--skip-phone");

  if (!FROM || !TO) {
    console.error(
      "Falta --from <UID> y/o --to <UID>. Ver cabecera del script."
    );
    process.exit(1);
    return;
  }
  if (FROM === TO) {
    console.error("--from y --to son iguales; nada que hacer.");
    process.exit(1);
    return;
  }

  const mode = apply ? "APPLY (escribe)" : "DRY-RUN (no escribe)";
  console.log(
    `reassign-user [${mode}] FROM=${FROM} TO=${TO} ` +
      `allExpenses=${allExpenses} includeLearning=${includeLearning} ` +
      `skipPhone=${skipPhone}`
  );

  admin.initializeApp();
  const db = getFirestore();

  // Verificación de existencia (evita reasignar a un TO inexistente).
  const [fromUser, toUser] = await Promise.all([
    db.collection("users").doc(FROM).get(),
    db.collection("users").doc(TO).get(),
  ]);
  if (!fromUser.exists) console.warn(`⚠️ users/${FROM} no existe.`);
  if (!toUser.exists) {
    console.error(`❌ users/${TO} no existe. Aborta.`);
    process.exit(1);
    return;
  }

  // 1. expenses FROM → TO
  const expSnap = await db
    .collection("expenses")
    .where("userId", "==", FROM)
    .get();
  const targets = expSnap.docs.filter(
    (d) => allExpenses || d.data().messageSid !== undefined
  );
  const skipped = expSnap.size - targets.length;
  console.log(
    `expenses: ${expSnap.size} de FROM, ${targets.length} a reasignar` +
      (skipped ? `, ${skipped} sin messageSid omitidos (usa --all-expenses)` : "")
  );
  if (apply) {
    let batch = db.batch();
    let pending = 0;
    for (const d of targets) {
      batch.update(d.ref, { userId: TO, updatedAt: Timestamp.now() });
      if (++pending >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    if (pending > 0) await batch.commit();
    console.log(`✅ expenses reasignados: ${targets.length}`);
  } else {
    targets.slice(0, 10).forEach((d) =>
      console.log(`  would reassign expenses/${d.id}`)
    );
  }

  // 2. learning_log (opcional, copia)
  if (includeLearning) {
    const llSnap = await db
      .collection("users").doc(FROM)
      .collection("learning_log").get();
    console.log(`learning_log: ${llSnap.size} entradas a copiar FROM → TO`);
    if (apply) {
      let batch = db.batch();
      let pending = 0;
      for (const d of llSnap.docs) {
        const ref = db
          .collection("users").doc(TO)
          .collection("learning_log").doc(d.id);
        batch.set(ref, d.data(), { merge: true });
        if (++pending >= BATCH_LIMIT) {
          await batch.commit();
          batch = db.batch();
          pending = 0;
        }
      }
      if (pending > 0) await batch.commit();
      console.log(`✅ learning_log copiado: ${llSnap.size}`);
    }
  }

  // 3. whatsappPhone: limpiar en FROM, setear en TO
  if (!skipPhone) {
    const phone = fromUser.data()?.whatsappPhone;
    console.log(
      `whatsappPhone: "${phone ?? "(ninguno)"}" mover de FROM → TO`
    );
    if (apply && phone) {
      await db.collection("users").doc(FROM).update({
        whatsappPhone: admin.firestore.FieldValue.delete(),
        whatsappLinkedAt: admin.firestore.FieldValue.delete(),
        updatedAt: new Date().toISOString(),
      });
      await db.collection("users").doc(TO).update({
        whatsappPhone: phone,
        whatsappLinkedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      console.log(`✅ whatsappPhone movido a users/${TO}`);
    }
  }

  console.log(apply ? "Hecho." : "DRY-RUN: nada se escribió. Revisa y re-corre con --apply.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("reassign-user falló:", err);
    process.exit(1);
  });
