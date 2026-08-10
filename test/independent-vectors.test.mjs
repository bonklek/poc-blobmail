import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Aes128Gcm, CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";

const vector = JSON.parse(await readFile(new URL("../vectors/blobmail-v0.json", import.meta.url), "utf8"));
const hex = (value) => Buffer.from(value, "hex");
const digest = (domain, bytes) => createHash("sha256").update(domain, "ascii").update(bytes).digest("hex");

test("independent verifier checks padded-text encoding without the primary encoder", () => {
  const padded = hex(vector.message.paddedPlaintextHex);
  assert.equal(padded.length, 512);
  assert.equal(padded.subarray(0, 4).toString("ascii"), "BMP0");
  assert.equal(padded[4], 0);
  assert.equal(padded[5], 1);
  const messageLength = padded.readUInt16BE(6);
  assert.equal(padded.subarray(8, 8 + messageLength).toString("hex"), vector.message.utf8Hex);
  assert.ok(padded.subarray(8 + messageLength).every((byte) => byte === 0));
  assert.equal(createHash("sha256").update(padded).digest("hex"), vector.message.paddedPlaintextSha256Hex);
});

test("independent verifier checks entry offsets and commitment", () => {
  const entry = hex(vector.encryption.entryHex);
  assert.equal(entry.length, 616);
  assert.equal(entry.subarray(0, 4).toString("ascii"), "BME0");
  assert.equal(entry[4], 0);
  assert.equal(entry[5], 1);
  assert.equal(entry.readUInt16BE(6), 0);
  assert.equal(entry.subarray(8, 24).toString("hex"), vector.encryption.recipientTagHex);
  assert.equal(entry.subarray(24, 56).toString("hex"), vector.encryption.encapsulatedKeyHex);
  assert.equal(
    digest("BlobMail/v0/entry-commitment\0", entry.subarray(0, 584)),
    vector.encryption.entryId,
  );
  assert.equal(entry.subarray(584).toString("hex"), vector.encryption.entryId);
});

test("independent verifier checks batch framing and commitment", () => {
  const batch = hex(vector.batch.batchHex);
  assert.equal(batch.subarray(0, 4).toString("ascii"), "BMB0");
  assert.equal(batch[4], 0);
  assert.equal(batch[5], 0);
  assert.equal(batch.readUInt16BE(6), 616);
  assert.equal(batch.readUInt16BE(8), 1);
  assert.equal(batch.readUInt16BE(10), 0);
  assert.equal(batch.readUInt32BE(12), 616);
  assert.equal(batch.length, 664);
  assert.equal(batch.subarray(16, 632).toString("hex"), vector.encryption.entryHex);
  assert.equal(digest("BlobMail/v0/batch-commitment\0", batch.subarray(0, -32)), vector.batch.batchId);
  assert.equal(batch.subarray(-32).toString("hex"), vector.batch.batchId);
});

test("independent HPKE setup reproduces key, exporter tag, and ciphertext", async () => {
  const suite = new CipherSuite({
    kem: new DhkemX25519HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes128Gcm(),
  });
  const bob = await suite.kem.deriveKeyPair(hex(vector.identities.bob.seedHex));
  assert.equal(
    Buffer.from(await suite.kem.serializePublicKey(bob.publicKey)).toString("hex"),
    vector.identities.bob.publicKeyHex,
  );
  const ephemeral = await suite.kem.deriveKeyPair(hex(vector.encryption.ephemeralSeedHex));
  const sender = await suite.createSenderContext({
    recipientPublicKey: bob.publicKey,
    info: Buffer.from("BlobMail/v0/hpke-info\0", "ascii"),
    ekm: ephemeral,
  });
  assert.equal(Buffer.from(sender.enc).toString("hex"), vector.encryption.encapsulatedKeyHex);
  assert.equal(
    Buffer.from(await sender.export(Buffer.from("BlobMail/v0/recipient-tag\0", "ascii"), 16)).toString("hex"),
    vector.encryption.recipientTagHex,
  );
  const entry = hex(vector.encryption.entryHex);
  const aad = Buffer.concat([Buffer.from("BlobMail/v0/aad\0", "ascii"), entry.subarray(0, 56)]);
  const ciphertext = await sender.seal(hex(vector.message.paddedPlaintextHex), aad);
  assert.equal(Buffer.from(ciphertext).toString("hex"), entry.subarray(56, 584).toString("hex"));
});
