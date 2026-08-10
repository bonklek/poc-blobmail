import assert from "node:assert/strict";
import test from "node:test";

import { createClientAdapter, createPreviewAdapter } from "../src/client/adapter.js";

const requiredEvidence = [
  "LOCAL_BATCH_CREATED",
  "BATCH_RECONSTRUCTED",
  "ENTRY_BYTES_VERIFIED",
  "DECRYPTED",
].map((code) => ({ code, detail: "fixture proof" }));

const request = {
  senderId: "alice",
  recipientId: "bob",
  plaintextBytes: new TextEncoder().encode("hello"),
};

test("verified adapter preserves decrypted bytes and normalizes evidence", async () => {
  const adapter = createClientAdapter({
    executeLoopback: async (input) => ({
      messageId: "message-1",
      batchId: "batch-1",
      receivedAt: "2026-08-10T00:00:00.000Z",
      plaintextBytes: new Uint8Array(input.plaintextBytes),
      evidence: requiredEvidence,
      receipt: { payloadDigest: "abc" },
    }),
  });

  const result = await adapter.sendToLocalBatch(request);
  assert.equal(new TextDecoder().decode(result.plaintextBytes), "hello");
  assert.ok(result.evidence.every((item) => item.status === "verified"));
  assert.equal(result.receipt.payloadDigest, "abc");
});

test("verified adapter rejects missing or reordered proof states", async () => {
  const adapter = createClientAdapter({
    executeLoopback: async () => ({
      messageId: "message-1",
      batchId: "batch-1",
      receivedAt: "2026-08-10T00:00:00.000Z",
      plaintextBytes: new TextEncoder().encode("hello"),
      evidence: [...requiredEvidence].reverse(),
    }),
  });

  await assert.rejects(adapter.sendToLocalBatch(request), /missing BATCH_RECONSTRUCTED/);
});

test("adapter rejects non-byte plaintext and invalid decrypted UTF-8", async () => {
  const adapter = createClientAdapter({
    executeLoopback: async () => ({
      messageId: "message-1",
      batchId: "batch-1",
      receivedAt: "2026-08-10T00:00:00.000Z",
      plaintextBytes: Uint8Array.of(0xff),
      evidence: requiredEvidence,
    }),
  });

  await assert.rejects(adapter.sendToLocalBatch({ ...request, plaintextBytes: "hello" }), /Uint8Array/);
  await assert.rejects(adapter.sendToLocalBatch(request), /encoded data was not valid|input did not conform/i);
});

test("standalone preview is explicitly labeled and never emits verified evidence", async () => {
  const adapter = createPreviewAdapter();
  const result = await adapter.sendToLocalBatch(request);

  assert.equal(adapter.runtime.mode, "preview");
  assert.ok(result.evidence.every((item) => item.status === "preview"));
  assert.ok(result.evidence.every((item) => /not executed/i.test(item.detail)));
});
