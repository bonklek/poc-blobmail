import {
  IDENTITIES,
  MAX_INBOX_MESSAGES,
  MAX_MESSAGE_BYTES,
  counterpart,
} from "./constants.js";

const encoder = new TextEncoder();

export function utf8ByteLength(value) {
  return encoder.encode(value).byteLength;
}

export function createInitialState(restored = {}) {
  const activeIdentity = IDENTITIES[restored.activeIdentity]
    ? restored.activeIdentity
    : "alice";
  const draftBody = typeof restored.draftBody === "string" ? restored.draftBody : "";

  return {
    activeIdentity,
    view: "compose",
    draft: {
      recipientId: counterpart(activeIdentity),
      body: utf8ByteLength(draftBody) <= MAX_MESSAGE_BYTES ? draftBody : "",
    },
    inbox: Array.isArray(restored.inbox)
      ? restored.inbox.slice(0, MAX_INBOX_MESSAGES)
      : [],
    evidence: [],
    error: null,
    latestMessageId: null,
  };
}

export function validateDraft(draft) {
  if (!draft || typeof draft.body !== "string") {
    return { ok: false, error: "Message text is required." };
  }
  if (!IDENTITIES[draft.recipientId]) {
    return { ok: false, error: "Choose a known local test recipient." };
  }

  const bytes = utf8ByteLength(draft.body);
  if (bytes === 0 || draft.body.trim().length === 0) {
    return { ok: false, error: "Write a message before review." };
  }
  if (bytes > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      error: `Message is ${bytes} bytes; the local limit is ${MAX_MESSAGE_BYTES}.`,
    };
  }
  return { ok: true, bytes };
}

export function setDraftBody(state, body) {
  return {
    ...state,
    draft: { ...state.draft, body },
    error: null,
  };
}

export function selectIdentity(state, identityId) {
  if (!IDENTITIES[identityId] || state.view === "sending") return state;
  return {
    ...state,
    activeIdentity: identityId,
    view: "compose",
    draft: { body: "", recipientId: counterpart(identityId) },
    evidence: [],
    error: null,
  };
}

export function openReview(state) {
  const validation = validateDraft(state.draft);
  if (!validation.ok) return { ...state, error: validation.error };
  return { ...state, view: "review", error: null, evidence: [] };
}

export function returnToCompose(state) {
  return { ...state, view: "compose", error: null, evidence: [] };
}

export function beginSend(state) {
  if (state.view !== "review") return state;
  return { ...state, view: "sending", error: null, evidence: [] };
}

export function finishSend(state, result) {
  const message = {
    id: result.messageId,
    batchId: result.batchId,
    receivedAt: result.receivedAt,
    senderId: state.activeIdentity,
    recipientId: state.draft.recipientId,
    body: new TextDecoder("utf-8", { fatal: true }).decode(result.plaintextBytes),
    evidence: result.evidence,
    receipt: result.receipt ?? {},
  };
  return {
    ...state,
    activeIdentity: message.recipientId,
    view: "inbox",
    draft: { recipientId: counterpart(message.recipientId), body: "" },
    inbox: [message, ...state.inbox.filter((item) => item.id !== message.id)].slice(
      0,
      MAX_INBOX_MESSAGES,
    ),
    evidence: result.evidence,
    latestMessageId: message.id,
    error: null,
  };
}

export function failSend(state, error) {
  return {
    ...state,
    view: "review",
    evidence: Array.isArray(error?.evidence) ? error.evidence : [],
    error: error instanceof Error ? error.message : "The local loopback failed.",
  };
}

export function showInbox(state) {
  return { ...state, view: "inbox", error: null };
}

export function showComposer(state) {
  return { ...state, view: "compose", error: null, evidence: [] };
}
