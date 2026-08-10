import {
  DOMAINS,
  ENTRY_CORE_SIZE,
  ENTRY_HEADER_SIZE,
  ENTRY_SIZE,
  HPKE_CIPHERTEXT_SIZE,
  HPKE_INFO,
  MAGIC,
  PROTOCOL_VERSION,
  SUITE_ID,
} from "./constants.js";
import {
  asBytes,
  bytesToHex,
  concatBytes,
  equalBytes,
  requireLength,
  requireMagic,
  readU16,
} from "./bytes.js";
import { domainHash, hpkeSuite } from "./crypto.js";
import { ProtocolError, fail } from "./errors.js";
import { decodePaddedText, encodePaddedText } from "./text.js";

async function resolvePublic(identityOrKey, explicitBytes) {
  const publicKey = identityOrKey?.publicKey ?? (identityOrKey?.type === "public" ? identityOrKey : undefined);
  if (publicKey) return publicKey;
  const publicKeyBytes = explicitBytes ?? identityOrKey?.publicKeyBytes ?? identityOrKey;
  if (!publicKeyBytes) fail("MISSING_PUBLIC_KEY", "recipient public key is required");
  try {
    return await hpkeSuite.kem.deserializePublicKey(requireLength(publicKeyBytes, 32, "recipient public key bytes"));
  } catch (cause) {
    throw new ProtocolError("INVALID_KEY", "recipient public key is invalid", undefined, cause);
  }
}

function resolveRecipient(identityOrKey) {
  const privateKey = identityOrKey?.privateKey ?? identityOrKey;
  if (!privateKey) fail("MISSING_PRIVATE_KEY", "recipient private key is required");
  return { privateKey };
}

export function parseEntry(value) {
  const bytes = requireLength(value, ENTRY_SIZE, "entry");
  requireMagic(bytes.subarray(0, 4), MAGIC.entry, "entry");
  if (bytes[4] !== PROTOCOL_VERSION) fail("UNKNOWN_ENTRY_VERSION", "unsupported entry version");
  if (bytes[5] !== SUITE_ID) fail("UNKNOWN_SUITE", "unsupported HPKE suite identifier");
  if (readU16(bytes, 6) !== 0) fail("UNKNOWN_ENTRY_FLAGS", "entry flags must be zero");
  return {
    entryBytes: bytes,
    header: bytes.subarray(0, ENTRY_HEADER_SIZE),
    recipientTag: bytes.subarray(8, 24),
    enc: bytes.subarray(24, 56),
    ciphertext: bytes.subarray(ENTRY_HEADER_SIZE, ENTRY_CORE_SIZE),
    commitment: bytes.subarray(ENTRY_CORE_SIZE),
  };
}

export async function verifyEntry(value) {
  const parsed = parseEntry(value);
  const expected = await domainHash(DOMAINS.entryCommitment, parsed.entryBytes.subarray(0, ENTRY_CORE_SIZE));
  if (!equalBytes(parsed.commitment, expected)) fail("ENTRY_COMMITMENT_MISMATCH", "entry commitment does not match bytes");
  return { ...parsed, entryId: bytesToHex(expected) };
}

export async function encryptText({
  text,
  recipientIdentity,
  recipientPublicKey,
  recipientPublicKeyBytes,
  ephemeralSeed,
} = {}) {
  const recipientKey = await resolvePublic(recipientIdentity ?? recipientPublicKey, recipientPublicKeyBytes);
  const padded = encodePaddedText(text);
  let sender;
  try {
    const params = { recipientPublicKey: recipientKey, info: HPKE_INFO };
    if (ephemeralSeed !== undefined) {
      params.ekm = await hpkeSuite.kem.deriveKeyPair(requireLength(ephemeralSeed, 32, "ephemeral seed"));
    }
    sender = await hpkeSuite.createSenderContext(params);
  } catch (cause) {
    throw new ProtocolError("HPKE_SETUP_FAILED", "HPKE sender setup failed", undefined, cause);
  }
  const enc = new Uint8Array(sender.enc);
  const tag = new Uint8Array(await sender.export(DOMAINS.recipientTag, 16));
  const header = new Uint8Array(ENTRY_HEADER_SIZE);
  header.set(MAGIC.entry, 0);
  header[4] = PROTOCOL_VERSION;
  header[5] = SUITE_ID;
  header.set(tag, 8);
  header.set(enc, 24);
  const aad = concatBytes(DOMAINS.aad, header);
  let ciphertext;
  try {
    ciphertext = new Uint8Array(await sender.seal(padded, aad));
  } catch (cause) {
    throw new ProtocolError("HPKE_SEAL_FAILED", "HPKE encryption failed", undefined, cause);
  }
  requireLength(ciphertext, HPKE_CIPHERTEXT_SIZE, "HPKE ciphertext");
  const core = concatBytes(header, ciphertext);
  const commitment = await domainHash(DOMAINS.entryCommitment, core);
  return {
    entryBytes: concatBytes(core, commitment),
    entryId: bytesToHex(commitment),
    recipientTag: tag,
    enc,
  };
}

export async function decryptEntry({ entryBytes, recipientIdentity, recipientPrivateKey, recipientPublicKeyBytes } = {}) {
  const parsed = await verifyEntry(entryBytes);
  const recipient = resolveRecipient(recipientIdentity ?? recipientPrivateKey);
  let context;
  try {
    context = await hpkeSuite.createRecipientContext({
      recipientKey: recipient.privateKey,
      enc: parsed.enc,
      info: HPKE_INFO,
    });
  } catch (cause) {
    throw new ProtocolError("HPKE_SETUP_FAILED", "HPKE recipient setup failed", undefined, cause);
  }
  const expectedTag = new Uint8Array(await context.export(DOMAINS.recipientTag, 16));
  if (!equalBytes(parsed.recipientTag, expectedTag)) fail("NOT_RECIPIENT", "entry is not tagged for this recipient");
  let padded;
  try {
    padded = new Uint8Array(await context.open(parsed.ciphertext, concatBytes(DOMAINS.aad, parsed.header)));
  } catch (cause) {
    throw new ProtocolError("HPKE_OPEN_FAILED", "HPKE authentication or decryption failed", undefined, cause);
  }
  return { ...decodePaddedText(padded), entryId: parsed.entryId };
}
