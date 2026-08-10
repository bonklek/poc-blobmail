import {
  IDENTITIES,
  MAX_INBOX_MESSAGES,
  MAX_MESSAGE_BYTES,
  MAX_PERSISTED_BYTES,
  STORAGE_KEY,
  STORAGE_VERSION,
} from "./constants.js";
import { utf8ByteLength } from "./state.js";

function cleanText(value, maxBytes) {
  if (typeof value !== "string" || utf8ByteLength(value) > maxBytes) return null;
  return value;
}

function sanitizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((item) => {
    const code = cleanText(item?.code, 64);
    const detail = cleanText(item?.detail ?? "", 512);
    const status = item?.status === "preview" ? "preview" : "verified";
    return code && detail !== null ? [{ code, detail, status }] : [];
  });
}

function sanitizeMessage(value) {
  if (!value || typeof value !== "object") return null;
  const id = cleanText(value.id, 128);
  const batchId = cleanText(value.batchId, 128);
  const body = cleanText(value.body, MAX_MESSAGE_BYTES);
  const receivedAt = cleanText(value.receivedAt, 64);
  if (
    !id ||
    !batchId ||
    body === null ||
    !receivedAt ||
    !IDENTITIES[value.senderId] ||
    !IDENTITIES[value.recipientId]
  ) {
    return null;
  }
  return {
    id,
    batchId,
    body,
    receivedAt,
    senderId: value.senderId,
    recipientId: value.recipientId,
    evidence: sanitizeEvidence(value.evidence),
    receipt: {},
  };
}

export function serializeClientState(state) {
  const record = {
    version: STORAGE_VERSION,
    activeIdentity: IDENTITIES[state.activeIdentity] ? state.activeIdentity : "alice",
    draftBody:
      typeof state.draft?.body === "string" &&
      utf8ByteLength(state.draft.body) <= MAX_MESSAGE_BYTES
        ? state.draft.body
        : "",
    inbox: Array.isArray(state.inbox)
      ? state.inbox.slice(0, MAX_INBOX_MESSAGES).flatMap((item) => {
          const clean = sanitizeMessage(item);
          return clean ? [clean] : [];
        })
      : [],
  };
  const encoded = JSON.stringify(record);
  if (utf8ByteLength(encoded) > MAX_PERSISTED_BYTES) {
    record.inbox = [];
    const withoutInbox = JSON.stringify(record);
    if (utf8ByteLength(withoutInbox) > MAX_PERSISTED_BYTES) {
      throw new Error("Local state exceeds the storage limit.");
    }
    return withoutInbox;
  }
  return encoded;
}

export function saveClientState(storage, state) {
  if (!storage?.setItem) return false;
  try {
    storage.setItem(STORAGE_KEY, serializeClientState(state));
    return true;
  } catch {
    return false;
  }
}

export function loadClientState(storage) {
  if (!storage?.getItem) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw || utf8ByteLength(raw) > MAX_PERSISTED_BYTES) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.version !== STORAGE_VERSION) return null;
    return {
      activeIdentity: IDENTITIES[parsed.activeIdentity] ? parsed.activeIdentity : "alice",
      draftBody: cleanText(parsed.draftBody ?? "", MAX_MESSAGE_BYTES) ?? "",
      inbox: Array.isArray(parsed.inbox)
        ? parsed.inbox.slice(0, MAX_INBOX_MESSAGES).flatMap((item) => {
            const clean = sanitizeMessage(item);
            return clean ? [clean] : [];
          })
        : [],
    };
  } catch {
    return null;
  }
}

export function clearClientState(storage) {
  if (!storage?.removeItem) return false;
  try {
    storage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
