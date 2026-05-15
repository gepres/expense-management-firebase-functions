import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { Account, Movement, MovementInput, MovementType } from "../types";

export interface WriteMovementResult {
  movementId: string;
  saldoAnterior: number;
  saldoNuevo: number;
}

export interface TransferInput {
  fromAccountId: string;
  toAccountId: string;
  monto: number;
  descripcion: string;
  fecha?: Timestamp;
}

export interface TransferResult {
  outMovementId: string;
  inMovementId: string;
  fromSaldoNuevo: number;
  toSaldoNuevo: number;
}

// Ledger append-only de movimientos. Fuente de verdad del saldo de cada
// cuenta — `accounts.saldo` es caché y se actualiza dentro de la misma
// transacción que escribe el movement.
export class MovementService {
  private db: FirebaseFirestore.Firestore;

  constructor() {
    this.db = getFirestore();
  }

  private movementsCol(userId: string): FirebaseFirestore.CollectionReference {
    return this.db.collection("users").doc(userId).collection("movements");
  }

  private accountDoc(
    userId: string,
    accountId: string
  ): FirebaseFirestore.DocumentReference {
    return this.db
      .collection("users")
      .doc(userId)
      .collection("accounts")
      .doc(accountId);
  }

  private deriveSigno(tipo: MovementType, override?: -1 | 1): -1 | 1 {
    switch (tipo) {
    case "gasto":
    case "transferencia_out":
      return -1;
    case "ingreso":
    case "transferencia_in":
    case "reversion":
      return 1;
    case "ajuste":
      if (override !== -1 && override !== 1) {
        throw new Error(
          "MovementService: tipo 'ajuste' requires explicit signoEfectivo"
        );
      }
      return override;
    }
  }

  private async applyMovement(
    tx: FirebaseFirestore.Transaction,
    userId: string,
    input: MovementInput,
    signo: -1 | 1
  ): Promise<WriteMovementResult> {
    const accountRef = this.accountDoc(userId, input.accountId);
    const movementRef = this.movementsCol(userId).doc();
    const now = Timestamp.now();

    const accountSnap = await tx.get(accountRef);
    if (!accountSnap.exists) {
      throw new Error(
        `MovementService: account ${input.accountId} not found (user ${userId})`
      );
    }
    const account = accountSnap.data() as Omit<Account, "id">;
    const saldoAnterior = account.saldo;
    const saldoNuevo = saldoAnterior + signo * input.monto;

    const movementDoc: Omit<Movement, "id"> = {
      accountId: input.accountId,
      tipo: input.tipo,
      monto: input.monto,
      signoEfectivo: signo,
      expenseId: input.expenseId,
      transferPairId: input.transferPairId,
      descripcion: input.descripcion,
      fecha: input.fecha,
      saldoAnterior,
      saldoNuevo,
      metadata: input.metadata,
      createdAt: now,
    };

    tx.set(movementRef, movementDoc);
    tx.update(accountRef, { saldo: saldoNuevo, updatedAt: now });

    return { movementId: movementRef.id, saldoAnterior, saldoNuevo };
  }

  // Escribe un movement y actualiza `accounts.saldo` atómicamente. Si recibe
  // `tx`, se ejecuta dentro de esa transacción; útil para componer con el
  // write del expense que origina el gasto.
  async writeMovement(
    userId: string,
    input: MovementInput,
    options?: { signoEfectivoOverride?: -1 | 1; tx?: FirebaseFirestore.Transaction }
  ): Promise<WriteMovementResult> {
    if (!Number.isFinite(input.monto) || input.monto <= 0) {
      throw new Error(
        `MovementService.writeMovement: monto debe ser > 0 (${input.monto})`
      );
    }
    const signo = this.deriveSigno(input.tipo, options?.signoEfectivoOverride);
    if (options?.tx) {
      return this.applyMovement(options.tx, userId, input, signo);
    }
    return this.db.runTransaction((tx) =>
      this.applyMovement(tx, userId, input, signo)
    );
  }

  // Transferencia entre dos cuentas del mismo usuario. Misma moneda
  // obligatoria (sin conversión en esta fase). Atómica: ambas o ninguna.
  async transfer(userId: string, input: TransferInput): Promise<TransferResult> {
    if (input.fromAccountId === input.toAccountId) {
      throw new Error("MovementService.transfer: origen y destino iguales");
    }
    if (!Number.isFinite(input.monto) || input.monto <= 0) {
      throw new Error(
        `MovementService.transfer: monto debe ser > 0 (${input.monto})`
      );
    }

    const fromRef = this.accountDoc(userId, input.fromAccountId);
    const toRef = this.accountDoc(userId, input.toAccountId);
    const outRef = this.movementsCol(userId).doc();
    const inRef = this.movementsCol(userId).doc();
    const fecha = input.fecha ?? Timestamp.now();
    const now = Timestamp.now();

    return this.db.runTransaction(async (tx) => {
      const [fromSnap, toSnap] = await Promise.all([
        tx.get(fromRef),
        tx.get(toRef),
      ]);
      if (!fromSnap.exists) {
        throw new Error(`Cuenta origen ${input.fromAccountId} no existe`);
      }
      if (!toSnap.exists) {
        throw new Error(`Cuenta destino ${input.toAccountId} no existe`);
      }
      const fromAcc = fromSnap.data() as Omit<Account, "id">;
      const toAcc = toSnap.data() as Omit<Account, "id">;
      if (fromAcc.moneda !== toAcc.moneda) {
        throw new Error(
          "Transferencia entre monedas no soportada: " +
            `${fromAcc.moneda} -> ${toAcc.moneda}`
        );
      }

      const fromSaldoNuevo = fromAcc.saldo - input.monto;
      const toSaldoNuevo = toAcc.saldo + input.monto;

      const outDoc: Omit<Movement, "id"> = {
        accountId: input.fromAccountId,
        tipo: "transferencia_out",
        monto: input.monto,
        signoEfectivo: -1,
        transferPairId: inRef.id,
        descripcion: input.descripcion,
        fecha,
        saldoAnterior: fromAcc.saldo,
        saldoNuevo: fromSaldoNuevo,
        createdAt: now,
      };
      const inDoc: Omit<Movement, "id"> = {
        accountId: input.toAccountId,
        tipo: "transferencia_in",
        monto: input.monto,
        signoEfectivo: 1,
        transferPairId: outRef.id,
        descripcion: input.descripcion,
        fecha,
        saldoAnterior: toAcc.saldo,
        saldoNuevo: toSaldoNuevo,
        createdAt: now,
      };

      tx.set(outRef, outDoc);
      tx.set(inRef, inDoc);
      tx.update(fromRef, { saldo: fromSaldoNuevo, updatedAt: now });
      tx.update(toRef, { saldo: toSaldoNuevo, updatedAt: now });

      return {
        outMovementId: outRef.id,
        inMovementId: inRef.id,
        fromSaldoNuevo,
        toSaldoNuevo,
      };
    });
  }

  async getMovementsByAccount(
    userId: string,
    accountId: string,
    limit: number = 20
  ): Promise<Movement[]> {
    try {
      const snap = await this.movementsCol(userId)
        .where("accountId", "==", accountId)
        .orderBy("fecha", "desc")
        .limit(limit)
        .get();
      return snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Movement, "id">),
      }));
    } catch (error) {
      logger.error("Error fetching movements:", error);
      return [];
    }
  }

  // Saldo de la cuenta a una fecha dada (incluyente). Recalcula desde el
  // ledger en vez de leer el caché — útil para auditoría o reportes.
  async getSaldoAtDate(
    userId: string,
    accountId: string,
    at: Timestamp
  ): Promise<number> {
    try {
      const snap = await this.movementsCol(userId)
        .where("accountId", "==", accountId)
        .where("fecha", "<=", at)
        .get();
      let saldo = 0;
      snap.forEach((doc) => {
        const m = doc.data() as Omit<Movement, "id">;
        saldo += m.signoEfectivo * m.monto;
      });
      return saldo;
    } catch (error) {
      logger.error("Error computing saldo at date:", error);
      return 0;
    }
  }

  async getByExpenseId(userId: string, expenseId: string): Promise<Movement[]> {
    try {
      const snap = await this.movementsCol(userId)
        .where("expenseId", "==", expenseId)
        .get();
      return snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Movement, "id">),
      }));
    } catch (error) {
      logger.error("Error fetching movements by expenseId:", error);
      return [];
    }
  }
}
