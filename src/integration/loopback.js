import {
  deriveIdentity,
  encryptText,
  packBatch,
  parseBatch,
  scanBatch,
  sha256,
} from "../protocol/index.js";
import {
  decodePayloadFromBlobs,
  encodePayloadToBlobs,
  sha256Hex,
} from "../transport/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const IDENTITY_NAMES = new Set(["alice", "bob"]);

let identityPromise;

async function deterministicIdentity(label) {
  const seed = await sha256(encoder.encode(`BlobMail/v0/local-demo/${label}\0`));
  return deriveIdentity(seed);
}

export async function localTestIdentities() {
  identityPromise ??= Promise.all([
    deterministicIdentity("alice"),
    deterministicIdentity("bob"),
  ]).then(([alice, bob]) => Object.freeze({ alice, bob }));
  return identityPromise;
}

function validateRequest({ senderId, recipientId, plaintextBytes } = {}) {
  if (!IDENTITY_NAMES.has(senderId) || !IDENTITY_NAMES.has(recipientId)) {
    throw new TypeError("senderId and recipientId must select a local test identity");
  }
  if (senderId === recipientId) throw new TypeError("local sender and recipient must differ");
  if (!(plaintextBytes instanceof Uint8Array) || plaintextBytes.length === 0) {
    throw new TypeError("plaintextBytes must be a non-empty Uint8Array");
  }
  return decoder.decode(plaintextBytes);
}

function isoTime(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new TypeError("loopback clock returned an invalid time");
  return date.toISOString();
}

/**
 * Executes a complete local-only BlobMail run. It creates no transaction,
 * sidecar request, wallet interaction, or network activity. The EIP-4844 blob
 * shape is an in-memory fixture and KZG/onchain inclusion are not claimed.
 */
export async function executeLoopback(
  request,
  { clock = () => new Date(), ephemeralSeed } = {},
) {
  const text = validateRequest(request);
  const identities = await localTestIdentities();
  const sender = identities[request.senderId];
  const recipient = identities[request.recipientId];

  const encrypted = await encryptText({
    text,
    recipientIdentity: recipient,
    ...(ephemeralSeed === undefined ? {} : { ephemeralSeed }),
  });
  const batch = await packBatch([encrypted.entryBytes]);
  const blobs = encodePayloadToBlobs(batch.batchBytes);
  const payloadDigest = await sha256Hex(batch.batchBytes);

  const reconstructed = decodePayloadFromBlobs(blobs, batch.batchBytes.length);
  const reconstructedDigest = await sha256Hex(reconstructed);
  if (reconstructedDigest !== payloadDigest) {
    throw new Error("local blob reconstruction digest mismatch");
  }

  const parsed = await parseBatch(reconstructed);
  const scan = await scanBatch({ batchBytes: reconstructed, recipientIdentity: recipient });
  if (scan.matches.length !== 1) {
    throw new Error(`expected one recipient match, found ${scan.matches.length}`);
  }
  const match = scan.matches[0];

  return {
    messageId: match.entryId,
    batchId: parsed.batchId,
    receivedAt: isoTime(clock),
    plaintextBytes: match.plaintextBytes,
    evidence: [
      {
        code: "LOCAL_BATCH_CREATED",
        detail: `One canonical entry was packed into ${blobs.length} in-memory blob fixture.`,
      },
      {
        code: "BATCH_RECONSTRUCTED",
        detail: "Canonical batch bytes were reconstructed from 31-byte field-element payload chunks.",
      },
      {
        code: "PAYLOAD_SHA256_VERIFIED",
        detail: "The reconstructed batch SHA-256 matched the pre-packing payload digest.",
      },
      {
        code: "ENTRY_BYTES_VERIFIED",
        detail: "Batch framing, canonical order, entry framing, and entry commitment were verified.",
      },
      {
        code: "DECRYPTED",
        detail: "The recipient tag matched and HPKE authentication recovered strict UTF-8 text locally.",
      },
    ],
    receipt: {
      selectedSenderIdentityId: sender.identityId,
      recipientIdentityId: recipient.identityId,
      entryDigest: match.entryId,
      payloadDigest,
      reconstructedDigest,
      blobCount: blobs.length,
      payloadBytes: batch.batchBytes.length,
      kzgProofVerified: false,
      chainIncluded: false,
      broadcast: false,
    },
  };
}
