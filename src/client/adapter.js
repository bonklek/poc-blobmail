import { REQUIRED_EVIDENCE_CODES } from "./constants.js";

function isByteArray(value) {
  return value instanceof Uint8Array;
}

function validateRequest(request) {
  if (!request || !["alice", "bob"].includes(request.senderId)) {
    throw new TypeError("A deterministic local sender is required.");
  }
  if (!["alice", "bob"].includes(request.recipientId)) {
    throw new TypeError("A deterministic local recipient is required.");
  }
  if (!isByteArray(request.plaintextBytes) || request.plaintextBytes.length === 0) {
    throw new TypeError("plaintextBytes must be a non-empty Uint8Array.");
  }
}

function normalizeEvidence(evidence) {
  if (!Array.isArray(evidence)) throw new Error("Loopback evidence is missing.");
  const normalized = evidence.map((item) => ({
    code: String(item?.code ?? ""),
    detail: String(item?.detail ?? ""),
    status: item?.status === "preview" ? "preview" : "verified",
  }));
  let cursor = -1;
  for (const code of REQUIRED_EVIDENCE_CODES) {
    cursor = normalized.findIndex((item, index) => index > cursor && item.code === code);
    if (cursor < 0) throw new Error(`Loopback evidence is missing ${code}.`);
  }
  return normalized;
}

function normalizeResult(result) {
  if (!result || typeof result !== "object") {
    throw new Error("Loopback engine returned no result.");
  }
  if (!isByteArray(result.plaintextBytes)) {
    throw new Error("Loopback result has no decrypted plaintext bytes.");
  }
  new TextDecoder("utf-8", { fatal: true }).decode(result.plaintextBytes);
  if (!result.messageId || !result.batchId) {
    throw new Error("Loopback result is missing replay identifiers.");
  }
  const receivedAt = String(result.receivedAt ?? "");
  if (Number.isNaN(Date.parse(receivedAt))) {
    throw new Error("Loopback result has an invalid receivedAt timestamp.");
  }
  return {
    messageId: String(result.messageId),
    batchId: String(result.batchId),
    receivedAt,
    plaintextBytes: result.plaintextBytes,
    evidence: normalizeEvidence(result.evidence),
    receipt: result.receipt && typeof result.receipt === "object" ? result.receipt : {},
  };
}

export function createClientAdapter({ executeLoopback, runtimeLabel = "Loopback engine" }) {
  if (typeof executeLoopback !== "function") {
    throw new TypeError("executeLoopback must be a function.");
  }
  return Object.freeze({
    runtime: Object.freeze({ mode: "verified", label: runtimeLabel }),
    async sendToLocalBatch(request) {
      validateRequest(request);
      return normalizeResult(await executeLoopback(request));
    },
  });
}

export function createPreviewAdapter() {
  let sequence = 0;
  return Object.freeze({
    runtime: Object.freeze({ mode: "preview", label: "Interface preview" }),
    async sendToLocalBatch(request) {
      validateRequest(request);
      sequence += 1;
      const suffix = String(sequence).padStart(4, "0");
      return normalizeResult({
        messageId: `preview-message-${suffix}`,
        batchId: `preview-batch-${suffix}`,
        receivedAt: new Date().toISOString(),
        plaintextBytes: new Uint8Array(request.plaintextBytes),
        evidence: REQUIRED_EVIDENCE_CODES.map((code) => ({
          code,
          status: "preview",
          detail: "UI preview only; this proof step was not executed.",
        })),
        receipt: {},
      });
    },
  });
}
