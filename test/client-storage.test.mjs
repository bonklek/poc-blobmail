import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INBOX_MESSAGES,
  MAX_PERSISTED_BYTES,
  STORAGE_KEY,
  STORAGE_VERSION,
} from "../src/client/constants.js";
import {
  clearClientState,
  loadClientState,
  saveClientState,
  serializeClientState,
} from "../src/client/storage.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

function validMessage(index) {
  return {
    id: `message-${index}`,
    batchId: `batch-${index}`,
    body: `hello ${index}`,
    receivedAt: "2026-08-10T00:00:00.000Z",
    senderId: "alice",
    recipientId: "bob",
    evidence: [{ code: "DECRYPTED", detail: "strict text", status: "verified" }],
    receipt: { ignoredUntrustedShape: true },
  };
}

test("storage roundtrip retains only bounded, allowlisted client state", () => {
  const storage = memoryStorage();
  const inbox = Array.from({ length: MAX_INBOX_MESSAGES + 4 }, (_, index) => validMessage(index));
  inbox.push({ arbitrary: "object" });

  assert.equal(
    saveClientState(storage, {
      activeIdentity: "bob",
      draft: { body: "bounded draft" },
      inbox,
    }),
    true,
  );
  const loaded = loadClientState(storage);
  assert.equal(loaded.activeIdentity, "bob");
  assert.equal(loaded.draftBody, "bounded draft");
  assert.equal(loaded.inbox.length, MAX_INBOX_MESSAGES);
  assert.deepEqual(loaded.inbox[0].receipt, {});
});

test("malformed, oversized, and unknown-version state fail closed", () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, "not json");
  assert.equal(loadClientState(storage), null);

  storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION + 1 }));
  assert.equal(loadClientState(storage), null);

  storage.setItem(STORAGE_KEY, "x".repeat(MAX_PERSISTED_BYTES + 1));
  assert.equal(loadClientState(storage), null);
});

test("serialization drops inbox if total state crosses the 32 KiB ceiling", () => {
  const hugeDetail = "x".repeat(500);
  const inbox = Array.from({ length: MAX_INBOX_MESSAGES }, (_, index) => ({
    ...validMessage(index),
    body: "b".repeat(500),
    evidence: Array.from({ length: 12 }, (_, evidenceIndex) => ({
      code: `EVIDENCE_${evidenceIndex}`,
      detail: hugeDetail,
    })),
  }));
  const serialized = serializeClientState({
    activeIdentity: "alice",
    draft: { body: "draft" },
    inbox,
  });

  assert.ok(new TextEncoder().encode(serialized).byteLength <= MAX_PERSISTED_BYTES);
  assert.deepEqual(JSON.parse(serialized).inbox, []);
});

test("clear removes only the BlobMail client key", () => {
  const storage = memoryStorage();
  storage.setItem(STORAGE_KEY, "blobmail");
  storage.setItem("unrelated", "keep");

  assert.equal(clearClientState(storage), true);
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(storage.getItem("unrelated"), "keep");
});
