import {
  BATCH_HEADER_SIZE,
  BATCH_TRAILER_SIZE,
  DOMAINS,
  ENTRY_SIZE,
  MAGIC,
  MAX_BATCH_ENTRIES,
  PROTOCOL_VERSION,
} from "./constants.js";
import {
  asBytes,
  bytesToHex,
  compareBytes,
  concatBytes,
  equalBytes,
  requireMagic,
  readU16,
  readU32,
  writeU16,
  writeU32,
} from "./bytes.js";
import { domainHash } from "./crypto.js";
import { decryptEntry, verifyEntry } from "./entry.js";
import { fail } from "./errors.js";

export async function packBatch(values) {
  if (!Array.isArray(values)) fail("INVALID_BATCH_ENTRIES", "entries must be an array");
  if (values.length === 0 || values.length > MAX_BATCH_ENTRIES) {
    fail("BATCH_COUNT_OUT_OF_BOUNDS", `batch must contain 1 to ${MAX_BATCH_ENTRIES} entries`);
  }
  const verified = await Promise.all(values.map((value) => verifyEntry(value)));
  verified.sort((left, right) => compareBytes(left.commitment, right.commitment));
  for (let index = 1; index < verified.length; index += 1) {
    if (equalBytes(verified[index - 1].commitment, verified[index].commitment)) {
      fail("DUPLICATE_ENTRY", "batch cannot contain duplicate entries");
    }
  }
  const header = new Uint8Array(BATCH_HEADER_SIZE);
  header.set(MAGIC.batch, 0);
  header[4] = PROTOCOL_VERSION;
  header[5] = 0;
  writeU16(header, 6, ENTRY_SIZE);
  writeU16(header, 8, verified.length);
  writeU16(header, 10, 0);
  writeU32(header, 12, verified.length * ENTRY_SIZE);
  const core = concatBytes(header, ...verified.map((entry) => entry.entryBytes));
  const commitment = await domainHash(DOMAINS.batchCommitment, core);
  return {
    batchBytes: concatBytes(core, commitment),
    batchId: bytesToHex(commitment),
    entryIds: verified.map((entry) => entry.entryId),
  };
}

export async function parseBatch(value) {
  const bytes = asBytes(value, "batch");
  if (bytes.length < BATCH_HEADER_SIZE + BATCH_TRAILER_SIZE) fail("BATCH_TRUNCATED", "batch is truncated");
  requireMagic(bytes.subarray(0, 4), MAGIC.batch, "batch");
  if (bytes[4] !== PROTOCOL_VERSION) fail("UNKNOWN_BATCH_VERSION", "unsupported batch version");
  if (bytes[5] !== 0) fail("UNKNOWN_BATCH_FLAGS", "batch flags must be zero");
  if (readU16(bytes, 6) !== ENTRY_SIZE) fail("UNKNOWN_ENTRY_SIZE", "batch entry size is not canonical");
  const count = readU16(bytes, 8);
  if (count === 0 || count > MAX_BATCH_ENTRIES) fail("BATCH_COUNT_OUT_OF_BOUNDS", "batch entry count is out of bounds");
  if (readU16(bytes, 10) !== 0) fail("NONZERO_RESERVED", "batch reserved field must be zero");
  const bodyLength = readU32(bytes, 12);
  if (bodyLength !== count * ENTRY_SIZE) fail("INVALID_BATCH_BODY_LENGTH", "batch body length is not canonical");
  const expectedLength = BATCH_HEADER_SIZE + bodyLength + BATCH_TRAILER_SIZE;
  if (bytes.length !== expectedLength) {
    fail("INVALID_BATCH_LENGTH", "batch length does not match its header", { actual: bytes.length, expected: expectedLength });
  }
  const core = bytes.subarray(0, bytes.length - BATCH_TRAILER_SIZE);
  const commitment = bytes.subarray(bytes.length - BATCH_TRAILER_SIZE);
  const expectedCommitment = await domainHash(DOMAINS.batchCommitment, core);
  if (!equalBytes(commitment, expectedCommitment)) fail("BATCH_COMMITMENT_MISMATCH", "batch commitment does not match bytes");
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const start = BATCH_HEADER_SIZE + index * ENTRY_SIZE;
    entries.push(await verifyEntry(bytes.slice(start, start + ENTRY_SIZE)));
  }
  for (let index = 1; index < entries.length; index += 1) {
    const order = compareBytes(entries[index - 1].commitment, entries[index].commitment);
    if (order === 0) fail("DUPLICATE_ENTRY", "batch contains duplicate entries");
    if (order > 0) fail("NON_CANONICAL_ORDER", "batch entries are not in commitment order");
  }
  return {
    batchBytes: bytes,
    batchId: bytesToHex(expectedCommitment),
    entryIds: entries.map((entry) => entry.entryId),
    entries: entries.map((entry) => entry.entryBytes),
  };
}

export async function scanBatch({ batchBytes, recipientIdentity } = {}) {
  if (!recipientIdentity?.privateKey) {
    fail("INVALID_RECIPIENT_IDENTITY", "scan requires a recipient private key");
  }
  const parsed = await parseBatch(batchBytes);
  const matches = [];
  let notForRecipient = 0;
  for (const entryBytes of parsed.entries) {
    try {
      matches.push(await decryptEntry({ entryBytes, recipientIdentity }));
    } catch (error) {
      if (error?.code === "NOT_RECIPIENT") {
        notForRecipient += 1;
        continue;
      }
      throw error;
    }
  }
  return { batchId: parsed.batchId, matches, notForRecipient };
}

export async function deduplicateEntries(values) {
  if (!Array.isArray(values)) fail("INVALID_ENTRIES", "entries must be an array");
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  for (const value of values) {
    const entry = await verifyEntry(value);
    if (seen.has(entry.entryId)) duplicates.push(entry.entryBytes);
    else {
      seen.add(entry.entryId);
      unique.push(entry.entryBytes);
    }
  }
  return { unique, duplicates };
}
