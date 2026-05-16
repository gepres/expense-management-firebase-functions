import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HELP_TOPICS,
  resolveHelpTopic,
  buildHelpMenu,
  buildHelpTopic,
  buildOnboarding,
} from "../config/help";

const WHATSAPP_MAX = 1600;

test("resolveHelpTopic: claves, aliases y laxo", () => {
  assert.equal(resolveHelpTopic(""), null);
  assert.equal(resolveHelpTopic("gastos"), "gastos");
  assert.equal(resolveHelpTopic("foto"), "gastos");
  assert.equal(resolveHelpTopic("dinero"), "saldo");
  assert.equal(resolveHelpTopic("cuenta"), "cuentas");
  assert.equal(resolveHelpTopic("clasificar"), "pendientes");
  assert.equal(resolveHelpTopic("aprendizajes"), "historial");
  assert.equal(resolveHelpTopic("cuentas nueva"), "cuentas");
  assert.equal(resolveHelpTopic("noexiste"), null);
});

test("buildHelpMenu: lista todos los temas y cabe en 1 WhatsApp", () => {
  const menu = buildHelpMenu();
  for (const key of Object.keys(HELP_TOPICS)) {
    assert.ok(
      menu.includes(`ayuda ${key}`),
      `el menú debe enlazar a "ayuda ${key}"`
    );
  }
  assert.ok(menu.length <= WHATSAPP_MAX);
});

test("buildHelpTopic: cada tema cabe en 1 WhatsApp", () => {
  for (const key of Object.keys(HELP_TOPICS) as Array<
    keyof typeof HELP_TOPICS
  >) {
    const body = buildHelpTopic(key);
    assert.ok(body.length > 0);
    assert.ok(
      body.length <= WHATSAPP_MAX,
      `tema "${key}" excede ${WHATSAPP_MAX} chars (${body.length})`
    );
  }
});

test("buildOnboarding: con/sin nombre y flag de vinculación", () => {
  const first = buildOnboarding("Luis", true);
  assert.ok(first.includes("Luis"));
  assert.ok(first.includes("vinculado"));
  const repeat = buildOnboarding(undefined, false);
  assert.ok(!repeat.includes("vinculado"));
  assert.ok(repeat.length <= WHATSAPP_MAX);
});
