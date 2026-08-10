import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  HPKE_SUITE,
  MAX_BATCH_ENTRIES,
  MAX_TEXT_BYTES,
  PADDED_PLAINTEXT_SIZE,
  ENTRY_SIZE,
  bytesToHex,
  decryptEntry,
  deriveIdentity,
  encodePaddedText,
  encryptText,
  hpkeSuite,
  packBatch,
  scanBatch,
} from "../src/protocol/index.js";

const range = (start) => Uint8Array.from({ length: 32 }, (_, index) => start + index);
const rawSha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const aliceSeed = range(0x00);
const bobSeed = range(0x40);
const ephemeralSeed = range(0x80);
const alice = await deriveIdentity(aliceSeed);
const bob = await deriveIdentity(bobSeed);
const message = "Hello, BlobMail! 📻";
const padded = encodePaddedText(message);
const encrypted = await encryptText({
  text: message,
  recipientIdentity: bob,
  ephemeralSeed,
});
const decrypted = await decryptEntry({ entryBytes: encrypted.entryBytes, recipientIdentity: bob });
const batch = await packBatch([encrypted.entryBytes]);
const scanned = await scanBatch({ batchBytes: batch.batchBytes, recipientIdentity: bob });

const vector = {
  schema: "blobmail.golden-vectors.v0",
  protocolVersion: 0,
  suite: {
    mode: HPKE_SUITE.mode,
    kemId: `0x${HPKE_SUITE.kem.toString(16).padStart(4, "0")}`,
    kdfId: `0x${HPKE_SUITE.kdf.toString(16).padStart(4, "0")}`,
    aeadId: `0x${HPKE_SUITE.aead.toString(16).padStart(4, "0")}`,
    hpkeInfoHex: bytesToHex(new TextEncoder().encode("BlobMail/v0/hpke-info\0")),
    recipientTagExporterContextHex: bytesToHex(new TextEncoder().encode("BlobMail/v0/recipient-tag\0")),
    recipientTagDerivation: "first 16 bytes of RFC 9180 HPKE Export(exporter_context, 16)",
  },
  limits: {
    maxTextBytes: MAX_TEXT_BYTES,
    paddedPlaintextSize: PADDED_PLAINTEXT_SIZE,
    entrySize: ENTRY_SIZE,
    maxBatchEntries: MAX_BATCH_ENTRIES,
  },
  fixtureWarning: "All seeds and keys in this file are public deterministic test fixtures. Never use them for value or private messages.",
  identities: {
    alice: {
      seedHex: bytesToHex(aliceSeed),
      publicKeyHex: bytesToHex(alice.publicKeyBytes),
      privateKeyHex: bytesToHex(alice.privateKeyBytes),
      identityId: alice.identityId,
    },
    bob: {
      seedHex: bytesToHex(bobSeed),
      publicKeyHex: bytesToHex(bob.publicKeyBytes),
      privateKeyHex: bytesToHex(bob.privateKeyBytes),
      identityId: bob.identityId,
    },
  },
  message: {
    text: message,
    utf8Hex: bytesToHex(new TextEncoder().encode(message)),
    paddedPlaintextHex: bytesToHex(padded),
    paddedPlaintextSha256Hex: rawSha256(padded),
  },
  encryption: {
    ephemeralSeedHex: bytesToHex(ephemeralSeed),
    recipientTagHex: bytesToHex(encrypted.recipientTag),
    encapsulatedKeyHex: bytesToHex(encrypted.enc),
    entryHex: bytesToHex(encrypted.entryBytes),
    entryId: encrypted.entryId,
  },
  batch: {
    batchHex: bytesToHex(batch.batchBytes),
    batchId: batch.batchId,
    entryIds: batch.entryIds,
  },
};

const corrupt = encrypted.entryBytes.slice();
corrupt[80] ^= 0x01;
let corruptionErrorCode;
try {
  await decryptEntry({ entryBytes: corrupt, recipientIdentity: bob });
} catch (error) {
  corruptionErrorCode = error.code;
}

const report = {
  schema: "blobmail.crypto-encoding-probe.v0",
  runtimes: {
    executedNode: process.version,
    browserBundleTarget: "ES modules using globalThis.crypto; Vite build and DOM integration evidence are recorded separately",
    visualBrowserProbe: "unavailable; no live-browser crypto claim",
  },
  packages: {
    "@hpke/core": packageJson.dependencies["@hpke/core"],
    "@hpke/dhkem-x25519": packageJson.dependencies["@hpke/dhkem-x25519"],
  },
  observedSuiteIds: {
    kem: hpkeSuite.kem.id,
    kdf: hpkeSuite.kdf.id,
    aead: hpkeSuite.aead.id,
  },
  candidates: {
    selected: "RFC 9180 base mode: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-128-GCM",
    rejected: [
      {
        candidate: "P-256 KEM",
        reason: "V0 keeps the smaller X25519 key encoding and its verified deterministic cross-implementation fixture.",
      },
      {
        candidate: "AES-256-GCM",
        reason: "No Sprint 0 requirement justified the larger key for the bounded local profile.",
      },
      {
        candidate: "JSON or CBOR wire envelope",
        reason: "The fixed binary envelope has byte-exact offsets and avoids a second canonicalization dependency.",
      },
    ],
  },
  fixture: {
    vector: "vectors/blobmail-v0.json",
    entryId: encrypted.entryId,
    batchId: batch.batchId,
  },
  probes: {
    deterministicKeyDerivation: bob.publicKeyBytes.length === 32 && bob.privateKeyBytes.length === 32,
    exactEntrySize: encrypted.entryBytes.length === ENTRY_SIZE,
    decryptRoundTrip: decrypted.text === message,
    scanRoundTrip: scanned.matches.length === 1 && scanned.matches[0].text === message,
    corruptedEntryRejectedAs: corruptionErrorCode,
  },
  commands: [
    "pnpm run vectors",
    "node --test test/protocol-v0.test.mjs test/independent-vectors.test.mjs",
    "pnpm run build",
  ],
  safety: "Fixture-only HPKE and byte encoding probe; no network, wallet, signing, transaction, or bundle surface.",
};

const vectorJson = `${JSON.stringify(vector, null, 2)}\n`;
const verifierBytes = await readFile(new URL("../test/independent-vectors.test.mjs", import.meta.url));
const manifest = {
  schema: "blobmail.vector-manifest.v0",
  generator: "scripts/generate-vectors.mjs",
  command: "pnpm run vectors",
  artifacts: [
    {
      path: "vectors/blobmail-v0.json",
      sha256: rawSha256(Buffer.from(vectorJson)),
    },
  ],
  independentVerifier: {
    path: "test/independent-vectors.test.mjs",
    sha256: rawSha256(verifierBytes),
    command: "node --test test/independent-vectors.test.mjs",
  },
  rejectionCoverage: [
    "corrupted entry and batch commitments",
    "oversized UTF-8 and batch inputs",
    "unknown plaintext, entry, and batch versions",
    "duplicate and noncanonical batch entries",
  ],
  fixtureWarning: vector.fixtureWarning,
};

await mkdir(new URL("../vectors/", import.meta.url), { recursive: true });
await mkdir(new URL("../reports/", import.meta.url), { recursive: true });
await writeFile(new URL("../vectors/blobmail-v0.json", import.meta.url), vectorJson);
await writeFile(new URL("../vectors/manifest.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(new URL("../reports/crypto-encoding-probe.json", import.meta.url), `${JSON.stringify(report, null, 2)}\n`);

console.log(`wrote vectors/blobmail-v0.json (${encrypted.entryBytes.length}-byte entry)`);
console.log(`wrote reports/crypto-encoding-probe.json (${corruptionErrorCode})`);
