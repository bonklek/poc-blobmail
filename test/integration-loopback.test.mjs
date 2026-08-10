import assert from "node:assert/strict";
import test from "node:test";

import { executeLoopback, localTestIdentities } from "../src/integration/loopback.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const fixedSeed = Uint8Array.from({ length: 32 }, (_, index) => 0xa0 + index);

test("verified local loopback encrypts, blob-packs, reconstructs, scans, and decrypts", async () => {
  const result = await executeLoopback(
    {
      senderId: "alice",
      recipientId: "bob",
      plaintextBytes: encoder.encode("meet me in the local blob fixture"),
    },
    {
      clock: () => new Date("2026-08-09T21:00:00-04:00"),
      ephemeralSeed: fixedSeed,
    },
  );

  assert.equal(decoder.decode(result.plaintextBytes), "meet me in the local blob fixture");
  assert.equal(result.messageId.length, 64);
  assert.equal(result.batchId.length, 64);
  assert.deepEqual(
    result.evidence.map(({ code }) => code),
    [
      "LOCAL_BATCH_CREATED",
      "BATCH_RECONSTRUCTED",
      "PAYLOAD_SHA256_VERIFIED",
      "ENTRY_BYTES_VERIFIED",
      "DECRYPTED",
    ],
  );
  assert.equal(result.receipt.payloadDigest, result.receipt.reconstructedDigest);
  assert.equal(result.receipt.blobCount, 1);
  assert.equal(result.receipt.kzgProofVerified, false);
  assert.equal(result.receipt.chainIncluded, false);
  assert.equal(result.receipt.broadcast, false);
});

test("deterministic test identities are stable and distinct", async () => {
  const first = await localTestIdentities();
  const second = await localTestIdentities();
  assert.equal(first.alice.identityId, second.alice.identityId);
  assert.notEqual(first.alice.identityId, first.bob.identityId);
});

test("loopback rejects invalid identity routing and invalid UTF-8", async () => {
  await assert.rejects(
    executeLoopback({ senderId: "alice", recipientId: "alice", plaintextBytes: encoder.encode("no") }),
    /must differ/,
  );
  await assert.rejects(
    executeLoopback({ senderId: "alice", recipientId: "bob", plaintextBytes: Uint8Array.of(0xff) }),
    /encoded data was not valid|not valid for encoding/i,
  );
});
