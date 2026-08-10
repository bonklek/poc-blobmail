import assert from "node:assert/strict";
import test from "node:test";
import {
  BATCH_HEADER_SIZE,
  BATCH_TRAILER_SIZE,
  DOMAINS,
  ENTRY_SIZE,
  MAX_TEXT_BYTES,
  ProtocolError,
  decryptEntry,
  decodePaddedText,
  deduplicateEntries,
  deriveIdentity,
  domainHash,
  encodePaddedText,
  encryptText,
  packBatch,
  parseBatch,
  parseEntry,
  scanBatch,
} from "../src/protocol/index.js";

const seed = (byte) => new Uint8Array(32).fill(byte);

async function fixture(text = "hello blob") {
  const bob = await deriveIdentity(seed(0x22));
  const eve = await deriveIdentity(seed(0x33));
  const entry = await encryptText({ text, recipientIdentity: bob, ephemeralSeed: seed(0x44) });
  return { bob, eve, entry };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof ProtocolError && error.code === code);
}

test("deterministic identities and HPKE fixtures round trip", async () => {
  const first = await fixture("radio check 📻");
  const second = await fixture("radio check 📻");
  assert.deepEqual(first.entry.entryBytes, second.entry.entryBytes);
  assert.equal(first.bob.identityId, second.bob.identityId);
  const opened = await decryptEntry({ entryBytes: first.entry.entryBytes, recipientIdentity: first.bob });
  assert.equal(opened.text, "radio check 📻");
  assert.deepEqual(opened.plaintextBytes, new TextEncoder().encode("radio check 📻"));
});

test("text is NFC-normalized and strictly bounded", async () => {
  const composed = "e\u0301";
  const padded = encodePaddedText(composed);
  const bob = await deriveIdentity(seed(1));
  const entry = await encryptText({ text: composed, recipientIdentity: bob, ephemeralSeed: seed(2) });
  const opened = await decryptEntry({ entryBytes: entry.entryBytes, recipientIdentity: bob });
  assert.equal(opened.text, "é");
  assert.equal(padded.length, 512);
  assert.throws(() => encodePaddedText(""), (error) => error.code === "EMPTY_TEXT");
  assert.throws(() => encodePaddedText("a".repeat(MAX_TEXT_BYTES + 1)), (error) => error.code === "TEXT_TOO_LARGE");
});

test("plaintext decoder rejects noncanonical version, UTF-8, and padding", () => {
  const unknown = encodePaddedText("ok");
  unknown[4] = 1;
  assert.throws(() => decodePaddedText(unknown), (error) => error.code === "UNKNOWN_PLAINTEXT_VERSION");

  const invalidUtf8 = encodePaddedText("ok");
  invalidUtf8[6] = 0;
  invalidUtf8[7] = 1;
  invalidUtf8[8] = 0xff;
  invalidUtf8[9] = 0;
  assert.throws(() => decodePaddedText(invalidUtf8), (error) => error.code === "INVALID_UTF8");

  const nonzeroPadding = encodePaddedText("ok");
  nonzeroPadding[511] = 1;
  assert.throws(() => decodePaddedText(nonzeroPadding), (error) => error.code === "NONZERO_RESERVED");
});

test("entry parser rejects version, flags, length, and commitment corruption", async () => {
  const { entry } = await fixture();
  const unknown = entry.entryBytes.slice();
  unknown[4] = 1;
  assert.throws(() => parseEntry(unknown), (error) => error.code === "UNKNOWN_ENTRY_VERSION");
  const flags = entry.entryBytes.slice();
  flags[7] = 1;
  assert.throws(() => parseEntry(flags), (error) => error.code === "UNKNOWN_ENTRY_FLAGS");
  assert.throws(() => parseEntry(entry.entryBytes.subarray(1)), (error) => error.code === "INVALID_LENGTH");
  const corrupt = entry.entryBytes.slice();
  corrupt[100] ^= 1;
  await expectCode(decryptEntry({ entryBytes: corrupt, recipientIdentity: (await fixture()).bob }), "ENTRY_COMMITMENT_MISMATCH");
});

test("recipient scan skips unrelated entries and decrypts its match", async () => {
  const bob = await deriveIdentity(seed(0x11));
  const eve = await deriveIdentity(seed(0x12));
  const forBob = await encryptText({ text: "for bob", recipientIdentity: bob, ephemeralSeed: seed(0x13) });
  const forEve = await encryptText({ text: "for eve", recipientIdentity: eve, ephemeralSeed: seed(0x14) });
  const batch = await packBatch([forEve.entryBytes, forBob.entryBytes]);
  const result = await scanBatch({ batchBytes: batch.batchBytes, recipientIdentity: bob });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].text, "for bob");
  assert.equal(result.notForRecipient, 1);
  await expectCode(decryptEntry({ entryBytes: forEve.entryBytes, recipientIdentity: bob }), "NOT_RECIPIENT");
});

test("exporter-tag mismatch and authenticated-open failure stay distinct", async () => {
  const { bob, entry } = await fixture();
  const wrongTag = entry.entryBytes.slice();
  wrongTag[8] ^= 1;
  wrongTag.set(await domainHash(DOMAINS.entryCommitment, wrongTag.subarray(0, ENTRY_SIZE - 32)), ENTRY_SIZE - 32);
  await expectCode(decryptEntry({ entryBytes: wrongTag, recipientIdentity: bob }), "NOT_RECIPIENT");

  const forgedCiphertext = entry.entryBytes.slice();
  forgedCiphertext[80] ^= 1;
  forgedCiphertext.set(
    await domainHash(DOMAINS.entryCommitment, forgedCiphertext.subarray(0, ENTRY_SIZE - 32)),
    ENTRY_SIZE - 32,
  );
  await expectCode(decryptEntry({ entryBytes: forgedCiphertext, recipientIdentity: bob }), "HPKE_OPEN_FAILED");
});

test("batch rejects corrupt, duplicate, reordered, and unknown-version fixtures", async () => {
  const bob = await deriveIdentity(seed(0x51));
  const first = await encryptText({ text: "first", recipientIdentity: bob, ephemeralSeed: seed(0x52) });
  const second = await encryptText({ text: "second", recipientIdentity: bob, ephemeralSeed: seed(0x53) });
  const packed = await packBatch([first.entryBytes, second.entryBytes]);

  const corrupt = packed.batchBytes.slice();
  corrupt[100] ^= 1;
  await expectCode(parseBatch(corrupt), "BATCH_COMMITMENT_MISMATCH");

  const unknown = packed.batchBytes.slice();
  unknown[4] = 1;
  await expectCode(parseBatch(unknown), "UNKNOWN_BATCH_VERSION");

  await expectCode(packBatch([first.entryBytes, first.entryBytes]), "DUPLICATE_ENTRY");

  const reordered = packed.batchBytes.slice();
  const left = reordered.slice(BATCH_HEADER_SIZE, BATCH_HEADER_SIZE + ENTRY_SIZE);
  const right = reordered.slice(BATCH_HEADER_SIZE + ENTRY_SIZE, BATCH_HEADER_SIZE + 2 * ENTRY_SIZE);
  reordered.set(right, BATCH_HEADER_SIZE);
  reordered.set(left, BATCH_HEADER_SIZE + ENTRY_SIZE);
  const core = reordered.subarray(0, reordered.length - BATCH_TRAILER_SIZE);
  reordered.set(await domainHash(DOMAINS.batchCommitment, core), reordered.length - BATCH_TRAILER_SIZE);
  await expectCode(parseBatch(reordered), "NON_CANONICAL_ORDER");
});

test("deduplication retains first verified entry", async () => {
  const { entry } = await fixture();
  const result = await deduplicateEntries([entry.entryBytes, entry.entryBytes.slice()]);
  assert.equal(result.unique.length, 1);
  assert.equal(result.duplicates.length, 1);
});
