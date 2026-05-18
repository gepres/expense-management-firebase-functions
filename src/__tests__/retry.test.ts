import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientError, withRetry } from "../utils/retry";

// Error tipo API con `status` (lint no-throw-literal: lanzar objetos Error).
const apiErr = (status: number): Error =>
  Object.assign(new Error(`HTTP ${status}`), { status });

test("isTransientError: 429 / 408 / 5xx son transitorios", () => {
  assert.equal(isTransientError({ status: 429 }), true);
  assert.equal(isTransientError({ status: 408 }), true);
  assert.equal(isTransientError({ status: 500 }), true);
  assert.equal(isTransientError({ status: 503 }), true);
  assert.equal(isTransientError({ statusCode: 502 }), true);
  assert.equal(isTransientError({ response: { status: 529 } }), true);
});

test("isTransientError: 4xx (≠429/408) NO son transitorios", () => {
  assert.equal(isTransientError({ status: 400 }), false);
  assert.equal(isTransientError({ status: 401 }), false);
  assert.equal(isTransientError({ status: 404 }), false);
});

test("isTransientError: códigos de red y nombres de SDK", () => {
  assert.equal(isTransientError({ code: "ECONNRESET" }), true);
  assert.equal(isTransientError({ code: "ETIMEDOUT" }), true);
  assert.equal(isTransientError({ name: "RateLimitError" }), true);
  assert.equal(isTransientError({ name: "APIConnectionError" }), true);
});

test("isTransientError: basura / definitivos → false", () => {
  assert.equal(isTransientError(null), false);
  assert.equal(isTransientError(undefined), false);
  assert.equal(isTransientError("boom"), false);
  assert.equal(isTransientError(new Error("plain")), false);
  assert.equal(isTransientError({ code: "EACCES" }), false);
});

test("withRetry: reintenta transitorio y luego resuelve", async () => {
  let calls = 0;
  const out = await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw apiErr(503);
      return "ok";
    },
    { retries: 3, baseDelayMs: 1, maxDelayMs: 2 }
  );
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

test("withRetry: error definitivo no se reintenta", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw apiErr(400);
        },
        { retries: 5, baseDelayMs: 1 }
      ),
    (e: { status?: number }) => e.status === 400
  );
  assert.equal(calls, 1);
});

test("withRetry: agota reintentos y relanza el último error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw apiErr(500);
        },
        { retries: 2, baseDelayMs: 1, maxDelayMs: 2 }
      ),
    (e: { status?: number }) => e.status === 500
  );
  assert.equal(calls, 3);
});
