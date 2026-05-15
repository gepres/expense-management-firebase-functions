import { test } from "node:test";
import assert from "node:assert/strict";
import { phraseMatches } from "../services/inference.service";
import { tokenizeForLearning } from "../services/learning-log.service";

test("phraseMatches: palabra completa, no substring", () => {
  assert.equal(phraseMatches("compre ropa nueva", "ropa"), true);
  // El falso positivo clásico: "ropa" NO debe matchear en "europa".
  assert.equal(phraseMatches("viaje a europa", "ropa"), false);
  assert.equal(
    phraseMatches("pollo a la brasa familiar", "pollo a la brasa"),
    true
  );
  assert.equal(phraseMatches("almuerzo", "almuerzo"), true);
  assert.equal(phraseMatches("almuerzos del mes", "almuerzo"), false);
  assert.equal(phraseMatches("cualquier cosa", ""), false);
});

test("tokenizeForLearning: filtra cortas y stopwords", () => {
  const tokens = tokenizeForLearning("gaste 50 soles en almuerzo familiar");
  assert.ok(tokens.includes("almuerzo"));
  assert.ok(tokens.includes("familiar"));
  assert.ok(!tokens.includes("soles"));
  assert.ok(!tokens.includes("gaste"));
  assert.ok(!tokens.includes("50"));
  assert.ok(!tokens.includes("en"));
  assert.ok(tokens.length <= 10);
});
