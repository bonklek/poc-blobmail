const ascii = (value) => new TextEncoder().encode(value);

export const PROTOCOL_VERSION = 0;
export const SUITE_ID = 1;
export const HPKE_SUITE = Object.freeze({
  kem: 0x0020,
  kdf: 0x0001,
  aead: 0x0001,
  mode: "base",
  name: "DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM",
});

export const TEXT_KIND = 1;
export const MAX_TEXT_BYTES = 480;
export const PADDED_PLAINTEXT_SIZE = 512;
export const ENTRY_HEADER_SIZE = 56;
export const HPKE_CIPHERTEXT_SIZE = PADDED_PLAINTEXT_SIZE + 16;
export const ENTRY_CORE_SIZE = ENTRY_HEADER_SIZE + HPKE_CIPHERTEXT_SIZE;
export const ENTRY_SIZE = ENTRY_CORE_SIZE + 32;
export const BATCH_HEADER_SIZE = 16;
export const BATCH_TRAILER_SIZE = 32;
export const MAX_BATCH_ENTRIES = 64;

export const MAGIC = Object.freeze({
  plaintext: ascii("BMP0"),
  entry: ascii("BME0"),
  batch: ascii("BMB0"),
});

export const DOMAINS = Object.freeze({
  identity: ascii("BlobMail/v0/identity\0"),
  recipientTag: ascii("BlobMail/v0/recipient-tag\0"),
  aad: ascii("BlobMail/v0/aad\0"),
  entryCommitment: ascii("BlobMail/v0/entry-commitment\0"),
  batchCommitment: ascii("BlobMail/v0/batch-commitment\0"),
});

export const HPKE_INFO = ascii("BlobMail/v0/hpke-info\0");
