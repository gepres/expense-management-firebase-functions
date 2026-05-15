import { test } from "node:test";
import assert from "node:assert/strict";
import { csvEscape, toCsv } from "../utils/csv";

test("csvEscape: valores simples", () => {
  assert.equal(csvEscape("hola"), "hola");
  assert.equal(csvEscape(50), "50");
  assert.equal(csvEscape(null), "");
  assert.equal(csvEscape(undefined), "");
});

test("csvEscape: comillas, comas y saltos", () => {
  assert.equal(csvEscape("a,b"), "\"a,b\"");
  assert.equal(csvEscape("dice \"hola\""), "\"dice \"\"hola\"\"\"");
  assert.equal(csvEscape("línea1\nlínea2"), "\"línea1\nlínea2\"");
});

test("toCsv: headers + filas con CRLF", () => {
  const csv = toCsv(
    ["fecha", "monto", "descripcion"],
    [
      ["2025-05-10", 50, "almuerzo"],
      ["2025-05-11", 25.5, "taxi, centro"],
    ]
  );
  assert.equal(
    csv,
    "fecha,monto,descripcion\r\n" +
      "2025-05-10,50,almuerzo\r\n" +
      "2025-05-11,25.5,\"taxi, centro\""
  );
});

test("toCsv: sin filas → solo headers", () => {
  assert.equal(toCsv(["a", "b"], []), "a,b");
});
