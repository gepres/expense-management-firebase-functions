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
  // "olvidar historial" pide confirmación; solo la frase explícita borra.
  assert.deepEqual(MessageParser.parseBotCommand("olvidar historial"), {
    kind: "olvidar_historial_prompt",
  });
  assert.deepEqual(
    MessageParser.parseBotCommand("olvidar historial confirmar"),
    { kind: "olvidar_historial" }
  );
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

test("parseQueryCommand: spent / list / discovery", () => {
  assert.deepEqual(MessageParser.parseQueryCommand("cuanto gaste hoy"), {
    kind: "spent",
    periodRaw: "hoy",
    categoria: undefined,
  });
  assert.deepEqual(
    MessageParser.parseQueryCommand("cuánto gasté en comida"),
    { kind: "spent", periodRaw: "", categoria: "comida" }
  );
  assert.deepEqual(
    MessageParser.parseQueryCommand("cuanto gaste en taxi esta semana"),
    { kind: "spent", periodRaw: "esta semana", categoria: "taxi" }
  );
  assert.deepEqual(MessageParser.parseQueryCommand("resumen mayo"), {
    kind: "spent",
    periodRaw: "mayo",
    categoria: undefined,
  });
  // "resumen" pelado → null (lo maneja el resumen histórico legacy).
  assert.equal(MessageParser.parseQueryCommand("resumen"), null);
  assert.deepEqual(MessageParser.parseQueryCommand("gastos de hoy"), {
    kind: "list",
    periodRaw: "hoy",
  });
  assert.deepEqual(MessageParser.parseQueryCommand("mis categorias"), {
    kind: "categories",
  });
  assert.deepEqual(
    MessageParser.parseQueryCommand("que cuentas tengo"),
    { kind: "accounts" }
  );
  assert.deepEqual(
    MessageParser.parseQueryCommand("mis métodos de pago"),
    { kind: "payments" }
  );
  // Un gasto normal no es una consulta.
  assert.equal(MessageParser.parseQueryCommand("50 almuerzo"), null);
  assert.equal(MessageParser.parseQueryCommand("hola"), null);
});

test("resolveQueryPeriod: rangos y etiquetas", () => {
  const hoy = MessageParser.resolveQueryPeriod("hoy");
  assert.equal(hoy.label, "hoy");
  assert.equal(hoy.start.getHours(), 0);
  assert.equal(
    hoy.end.getTime() - hoy.start.getTime(),
    24 * 60 * 60 * 1000
  );

  const vacio = MessageParser.resolveQueryPeriod("");
  assert.ok(vacio.label.includes("este mes"));
  assert.equal(vacio.start.getDate(), 1);
  assert.ok(vacio.end > vacio.start);

  const pasado = MessageParser.resolveQueryPeriod("mes pasado");
  const now = new Date();
  const expected = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  assert.equal(pasado.start.getMonth(), expected.getMonth());
  assert.equal(pasado.start.getDate(), 1);
});

test("parseEditCommand: borrar / corregir último", () => {
  assert.deepEqual(MessageParser.parseEditCommand("borrar último"), {
    kind: "delete_last",
  });
  assert.deepEqual(MessageParser.parseEditCommand("elimina el ultimo"), {
    kind: "delete_last",
  });
  assert.deepEqual(MessageParser.parseEditCommand("deshacer"), {
    kind: "delete_last",
  });
  assert.deepEqual(
    MessageParser.parseEditCommand("corrige el monto a 60"),
    { kind: "correct_amount", monto: 60 }
  );
  assert.deepEqual(MessageParser.parseEditCommand("no, eran 25.50"), {
    kind: "correct_amount",
    monto: 25.5,
  });
  assert.deepEqual(MessageParser.parseEditCommand("el ultimo era 80"), {
    kind: "correct_amount",
    monto: 80,
  });
  assert.equal(MessageParser.parseEditCommand("50 almuerzo"), null);
  assert.equal(MessageParser.parseEditCommand("borrar"), null);
});

test("parseConfirmation: sí / no / null", () => {
  assert.equal(MessageParser.parseConfirmation("sí"), "yes");
  assert.equal(MessageParser.parseConfirmation("Si"), "yes");
  assert.equal(MessageParser.parseConfirmation("confirmar"), "yes");
  assert.equal(MessageParser.parseConfirmation("no"), "no");
  assert.equal(MessageParser.parseConfirmation("cancelar"), "no");
  assert.equal(MessageParser.parseConfirmation("no quiero"), null);
  assert.equal(MessageParser.parseConfirmation("50 almuerzo"), null);
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
