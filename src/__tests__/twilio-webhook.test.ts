import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQueueDocFromTwilio } from "../utils/twilio-webhook";

test("buildQueueDocFromTwilio: mapeo básico de texto", () => {
  const doc = buildQueueDocFromTwilio({
    From: "whatsapp:+51 999 888 777",
    Body: "50 almuerzo",
    MessageSid: "SM123",
    NumMedia: "0",
  });
  assert.equal(doc.phoneNumber, "+51999888777");
  assert.equal(doc.message, "50 almuerzo");
  assert.equal(doc.status, "pending");
  assert.equal(doc.retryCount, 0);
  assert.equal(doc.webhookBody.MessageSid, "SM123");
  assert.equal(doc.webhookBody.From, "whatsapp:+51 999 888 777");
  assert.equal(doc.webhookBody.NumMedia, "0");
  assert.equal("createdAt" in doc, false);
});

test("buildQueueDocFromTwilio: media y campos opcionales", () => {
  const doc = buildQueueDocFromTwilio({
    From: "whatsapp:+51999888777",
    Body: "",
    MessageSid: "SM999",
    NumMedia: "1",
    MediaUrl0: "https://api.twilio.com/media/abc",
    MediaContentType0: "image/jpeg",
    ProfileName: "Gepres",
  });
  assert.equal(doc.webhookBody.MediaUrl0, "https://api.twilio.com/media/abc");
  assert.equal(doc.webhookBody.MediaContentType0, "image/jpeg");
  assert.equal(doc.webhookBody.ProfileName, "Gepres");
  // Sin claves undefined (Firestore las rechaza).
  for (const v of Object.values(doc.webhookBody)) {
    assert.notEqual(v, undefined);
  }
});

test("buildQueueDocFromTwilio: campos faltantes → strings vacíos", () => {
  const doc = buildQueueDocFromTwilio({ From: "whatsapp:+51111222333" });
  assert.equal(doc.message, "");
  assert.equal(doc.webhookBody.Body, "");
  assert.equal(doc.webhookBody.MessageSid, "");
  assert.equal(doc.webhookBody.MediaUrl0, undefined);
});
