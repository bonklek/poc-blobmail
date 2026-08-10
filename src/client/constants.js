export const MAX_MESSAGE_BYTES = 480;
export const MAX_INBOX_MESSAGES = 12;
export const MAX_PERSISTED_BYTES = 32 * 1024;
export const STORAGE_KEY = "blobmail.loopback.client.v1";
export const STORAGE_VERSION = 1;

export const IDENTITIES = Object.freeze({
  alice: Object.freeze({
    id: "alice",
    name: "Alice",
    monogram: "A",
    fingerprint: "7E2A:49D4:01AC",
    color: "coral",
  }),
  bob: Object.freeze({
    id: "bob",
    name: "Bob",
    monogram: "B",
    fingerprint: "B193:8C0F:72EE",
    color: "violet",
  }),
});

export const REQUIRED_EVIDENCE_CODES = Object.freeze([
  "LOCAL_BATCH_CREATED",
  "BATCH_RECONSTRUCTED",
  "ENTRY_BYTES_VERIFIED",
  "DECRYPTED",
]);

export function counterpart(identityId) {
  return identityId === "bob" ? "alice" : "bob";
}
