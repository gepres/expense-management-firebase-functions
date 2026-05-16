import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageParser } from "../utils/message-parser";

test("normalizeForMatching: minúsculas, sin tildes, espacios", () => {
  assert.equal(
    MessageParser.normalizeForMatching("  Café   CON  Leche "),
    "cafe con leche"
  );
});

test("validateAmount", () => {
  assert.equal(MessageParser.validateAmount(0).ok, false);
  assert.equal(MessageParser.validateAmount(-5).ok, false);
  assert.equal(MessageParser.validateAmount(NaN).ok, false);
  const ok = MessageParser.validateAmount(10.567);
  assert.equal(ok.ok, true);
  assert.equal(ok.value, 10.57);
});

test("parseExpenseFromText", () => {
  const a = MessageParser.parseExpenseFromText("50 almuerzo");
  assert.deepEqual(a, { amount: 50, description: "almuerzo" });
  const b = MessageParser.parseExpenseFromText("Gasté 25.50 en taxi");
  assert.equal(b?.amount, 25.5);
  assert.equal(b?.description, "taxi");
  assert.equal(MessageParser.parseExpenseFromText("hola"), null);
});

test("normalizePhoneNumber", () => {
  assert.equal(
    MessageParser.normalizePhoneNumber("whatsapp:+51 999 999 999"),
    "+51999999999"
  );
});

test("sanitizeInput quita <script> y <>", () => {
  assert.equal(
    MessageParser.sanitizeInput("<script>alert(1)</script>hola"),
    "hola"
  );
});

test("parseAccountCommand", () => {
  assert.deepEqual(MessageParser.parseAccountCommand("cuenta actual"), {
    kind: "current",
  });
  assert.deepEqual(MessageParser.parseAccountCommand("cuenta principal"), {
    kind: "primary",
  });
  assert.deepEqual(
    MessageParser.parseAccountCommand("usar cuenta negocio"),
    { kind: "use", nombre: "negocio" }
  );
  assert.equal(MessageParser.parseAccountCommand("hola"), null);
});

test("parseBotCommand", () => {
  assert.deepEqual(MessageParser.parseBotCommand("saldo"), {
    kind: "saldo",
  });
  assert.deepEqual(MessageParser.parseBotCommand("saldo de cuentas"), {
    kind: "saldos",
  });
  assert.deepEqual(
    MessageParser.parseBotCommand("ingreso 500 sueldo mayo"),
    { kind: "ingreso", monto: 500, descripcion: "sueldo mayo" }
  );
  assert.deepEqual(
    MessageParser.parseBotCommand("transferir 100 a negocio"),
    { kind: "transferir", monto: 100, cuenta: "negocio" }
  );
  assert.deepEqual(
    MessageParser.parseBotCommand("clasificar abc123 comida cena"),
    {
      kind: "clasificar",
      expenseId: "abc123",
      categoria: "comida",
      subcategoria: "cena",
    }
  );
  // IDs de Firestore son case-sensitive: el ID conserva mayúsculas;
  // categoría/subcategoría se normalizan a minúsculas.
  assert.deepEqual(
    MessageParser.parseBotCommand("clasificar 43lUXIhJx6VHp6JYKl51 Transporte"),
    {
      kind: "clasificar",
      expenseId: "43lUXIhJx6VHp6JYKl51",
      categoria: "transporte",
      subcategoria: undefined,
    }
  );
  assert.deepEqual(MessageParser.parseBotCommand("pendientes"), {
    kind: "pendientes",
  });
  assert.deepEqual(MessageParser.parseBotCommand("olvidar historial"), {
    kind: "olvidar_historial",
  });
  assert.deepEqual(MessageParser.parseBotCommand("mi historial"), {
    kind: "historial",
  });
  assert.equal(MessageParser.parseBotCommand("50 almuerzo"), null);
});

test("parseHelpCommand", () => {
  assert.deepEqual(MessageParser.parseHelpCommand("ayuda"), { rest: "" });
  assert.deepEqual(MessageParser.parseHelpCommand("/ayuda"), { rest: "" });
  assert.deepEqual(MessageParser.parseHelpCommand("Comandos"), { rest: "" });
  assert.deepEqual(MessageParser.parseHelpCommand("menú"), { rest: "" });
  assert.deepEqual(MessageParser.parseHelpCommand("ayuda gastos"), {
    rest: "gastos",
  });
  assert.deepEqual(MessageParser.parseHelpCommand("AYUDA  Saldo"), {
    rest: "saldo",
  });
  assert.equal(MessageParser.parseHelpCommand("50 almuerzo"), null);
  assert.equal(MessageParser.parseHelpCommand("ayudame con esto"), null);
});

test("hasTemporalHint", () => {
  assert.equal(
    MessageParser.hasTemporalHint("lo compré hace una semana"),
    true
  );
  assert.equal(
    MessageParser.hasTemporalHint("pagué el viernes pasado"),
    true
  );
  assert.equal(MessageParser.hasTemporalHint("50 almuerzo"), false);
});

test("parseDateFromText: ISO y relativos", () => {
  const iso = MessageParser.parseDateFromText("gasté 10 el 2025-05-10");
  assert.ok(iso);
  assert.equal(iso?.getFullYear(), 2025);
  assert.equal(iso?.getMonth(), 4);
  assert.equal(iso?.getDate(), 10);

  const hoy = MessageParser.parseDateFromText("50 almuerzo hoy");
  const now = new Date();
  assert.equal(hoy?.getDate(), now.getDate());

  assert.equal(MessageParser.parseDateFromText("50 almuerzo"), null);
});
