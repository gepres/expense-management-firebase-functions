import { test } from "node:test";
import assert from "node:assert/strict";
import {
  phraseMatches,
  categoryIdForTerm,
} from "../services/inference.service";
import type { Category } from "../types";
import {
  tokenizeForLearning,
  tokenOverlap,
} from "../services/learning-log.service";

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

test("tokenOverlap: overlap coef tolerante a longitud", () => {
  // Sets vacíos → 0 (no reusar historial sin señal).
  assert.equal(tokenOverlap([], ["taxi"]), 0);
  assert.equal(tokenOverlap(["taxi"], []), 0);
  // Igualdad exacta → 1.
  assert.equal(tokenOverlap(["taxi"], ["taxi"]), 1);
  // Corrección corta contenida en descripción larga → 1 (clave del
  // bucle de aprendizaje: "taxi" enseñado aplica a "taxi al centro").
  assert.equal(
    tokenOverlap(["taxi", "centro", "comercial"], ["taxi"]),
    1
  );
  // Sin tokens comunes → 0.
  assert.equal(tokenOverlap(["pago", "realizado"], ["taxi"]), 0);
  // Solape parcial: 1 común sobre min(2,2)=2 → 0.5 (umbral límite).
  assert.equal(
    tokenOverlap(["almuerzo", "pollo"], ["almuerzo", "trabajo"]),
    0.5
  );
  // Simétrico.
  assert.equal(
    tokenOverlap(["a", "b"], ["b", "c", "d"]),
    tokenOverlap(["b", "c", "d"], ["a", "b"])
  );
});

test("categoryIdForTerm: mapea hint/candidato a categoría del usuario", () => {
  const cats = [
    { id: "transporte", nombre: "Transporte", subcategorias: [] },
    { id: "comida", nombre: "Alimentación", subcategorias: [] },
  ] as unknown as Category[];

  // Hint libre del LLM == nombre (sin diacríticos, case-insensitive).
  assert.equal(categoryIdForTerm("transporte", cats), "transporte");
  assert.equal(categoryIdForTerm("Transporte", cats), "transporte");
  // Match por id exacto.
  assert.equal(categoryIdForTerm("comida", cats), "comida");
  // Match por nombre con diacríticos.
  assert.equal(categoryIdForTerm("alimentacion", cats), "comida");
  // Frase: el nombre aparece como palabra completa en el término.
  assert.equal(
    categoryIdForTerm("transporte publico", cats),
    "transporte"
  );
  // Sin correspondencia → null.
  assert.equal(categoryIdForTerm("salud", cats), null);
  assert.equal(categoryIdForTerm("", cats), null);
});
