import { executeLoopback } from "../../../src/integration/loopback.js";

const STATE_KEY = "milxdy.local.blobmail-loopback.state.v1";
const PERSIST_KEY = "milxdy.local.blobmail-loopback.persistFixtureHistory";
const MAX_TEXT_BYTES = 480;
const MAX_MESSAGES = 12;
const encoder = new TextEncoder();

let appContext = null;
let panel = null;
let previousFocus = null;
let currentRun = 0;

/** @param {import("../../../../sdk/types/index.d.ts").MilxdyContentAppContext} context */
export function boot(context) {
  appContext = context;
  context.recordDiagnostic("blobmail-loopback.ready", {
    fixtureOnly: true,
    network: false,
    broadcast: false,
  });
  context.addDisposable(removePanel);
}

export async function open() {
  if (!appContext || appContext.signal.aborted || panel) return;
  const run = ++currentRun;
  const stored = await appContext.storage.local.get({ [PERSIST_KEY]: false, [STATE_KEY]: null });
  if (!isCurrent(run)) return;
  const persist = stored[PERSIST_KEY] === true;
  const inbox = persist ? sanitizeInbox(stored[STATE_KEY]?.inbox) : [];
  renderPanel({ persist, inbox });
  appContext.recordDiagnostic("blobmail-loopback.open", true);
}

export function close() {
  currentRun += 1;
  removePanel();
  appContext?.recordDiagnostic("blobmail-loopback.open", false);
}

export function disable() {
  close();
}

export function dispose() {
  close();
  appContext = null;
}

function isCurrent(run) {
  return Boolean(appContext && !appContext.signal.aborted && run === currentRun);
}

function sanitizeInbox(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_MESSAGES).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    if (!["alice", "bob"].includes(item.senderId) || !["alice", "bob"].includes(item.recipientId)) return [];
    if (typeof item.body !== "string" || encoder.encode(item.body).byteLength > MAX_TEXT_BYTES) return [];
    if (typeof item.messageId !== "string" || item.messageId.length > 128) return [];
    if (typeof item.batchId !== "string" || item.batchId.length > 128) return [];
    return [{
      senderId: item.senderId,
      recipientId: item.recipientId,
      body: item.body,
      messageId: item.messageId,
      batchId: item.batchId,
      receivedAt: typeof item.receivedAt === "string" ? item.receivedAt.slice(0, 64) : "",
      evidence: Array.isArray(item.evidence)
        ? item.evidence.slice(0, 8).map((entry) => ({ code: String(entry?.code ?? "").slice(0, 64) }))
        : [],
    }];
  });
}

function renderPanel(model) {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  panel = document.createElement("aside");
  panel.className = "blobmail-sdk-panel";
  panel.tabIndex = -1;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "blobmail-sdk-title");

  const header = el("header", "blobmail-sdk-header");
  const headingWrap = el("div");
  const eyebrow = el("span", "blobmail-sdk-eyebrow", "FIXTURE-ONLY / V0");
  const heading = el("h2", "blobmail-sdk-title", "BlobMail Loopback");
  heading.id = "blobmail-sdk-title";
  headingWrap.append(eyebrow, heading);
  const closeButton = button("Close BlobMail", "×", "blobmail-sdk-close");
  closeButton.addEventListener("click", close);
  header.append(headingWrap, closeButton);

  const notice = el("div", "blobmail-sdk-notice");
  notice.append(el("strong", "", "Local evidence lab"), el("span", "", "No wallet · no network · no transaction · no delivery claim"));

  const body = el("div", "blobmail-sdk-body");
  const nav = el("div", "blobmail-sdk-nav");
  const composeTab = button("Compose message", "Compose", "is-active");
  const inboxTab = button("View local inbox", `Inbox (${model.inbox.length})`);
  nav.append(composeTab, inboxTab);
  const content = el("div", "blobmail-sdk-content");
  body.append(nav, content);

  panel.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  });
  panel.append(header, notice, body);
  document.body.append(panel);
  panel.focus();

  composeTab.addEventListener("click", () => {
    composeTab.classList.add("is-active");
    inboxTab.classList.remove("is-active");
    renderCompose(content, model, inboxTab);
  });
  inboxTab.addEventListener("click", () => {
    inboxTab.classList.add("is-active");
    composeTab.classList.remove("is-active");
    renderInbox(content, model);
  });
  renderCompose(content, model, inboxTab);
}

function renderCompose(content, model, inboxTab) {
  content.replaceChildren();
  const form = el("div", "blobmail-sdk-compose");
  const route = el("div", "blobmail-sdk-route");
  const sender = selectIdentity("From", "alice");
  const recipient = selectIdentity("To", "bob");
  route.append(sender.label, sender.select, el("span", "blobmail-sdk-arrow", "→"), recipient.label, recipient.select);

  sender.select.addEventListener("change", () => {
    recipient.select.value = sender.select.value === "alice" ? "bob" : "alice";
  });
  recipient.select.addEventListener("change", () => {
    sender.select.value = recipient.select.value === "alice" ? "bob" : "alice";
  });

  const label = el("label", "blobmail-sdk-label", "Message");
  const textarea = document.createElement("textarea");
  textarea.rows = 7;
  textarea.placeholder = "Write up to 480 UTF-8 bytes…";
  textarea.setAttribute("aria-label", "Fixture message");
  const count = el("span", "blobmail-sdk-count", `0 / ${MAX_TEXT_BYTES} bytes`);
  const error = el("p", "blobmail-sdk-error");
  error.hidden = true;
  textarea.addEventListener("input", () => {
    const bytes = encoder.encode(textarea.value).byteLength;
    count.textContent = `${bytes} / ${MAX_TEXT_BYTES} bytes`;
    count.classList.toggle("is-over", bytes > MAX_TEXT_BYTES);
    error.hidden = true;
  });

  const persistRow = el("label", "blobmail-sdk-consent");
  const persistToggle = document.createElement("input");
  persistToggle.type = "checkbox";
  persistToggle.checked = model.persist;
  persistRow.append(persistToggle, el("span", "", "Save up to 12 decrypted fixture messages as plaintext locally"));
  persistToggle.addEventListener("change", async () => {
    if (!appContext || appContext.signal.aborted) return;
    model.persist = persistToggle.checked;
    await appContext.storage.local.set({ [PERSIST_KEY]: model.persist });
    if (!model.persist && appContext && !appContext.signal.aborted) {
      await appContext.storage.local.remove(STATE_KEY);
      model.inbox = [];
      inboxTab.textContent = "Inbox (0)";
    }
  });

  const review = el("div", "blobmail-sdk-review");
  review.hidden = true;
  const reviewText = el("p", "blobmail-sdk-review-text");
  const proof = el("p", "blobmail-sdk-proof", "This executes encryption, canonical batching, blob-shaped reconstruction, digest checks, recipient scan, and local decryption. It does not broadcast or deliver.");
  const actionRow = el("div", "blobmail-sdk-actions");
  const reviewButton = button("Review message", "Review local batch", "blobmail-sdk-primary");
  const editButton = button("Edit message", "Back to edit");
  const sendButton = button("Execute local loopback", "Send to local batch", "blobmail-sdk-primary");
  actionRow.append(reviewButton);

  reviewButton.addEventListener("click", () => {
    const bytes = encoder.encode(textarea.value).byteLength;
    if (textarea.value.trim().length === 0 || bytes > MAX_TEXT_BYTES) {
      error.textContent = bytes > MAX_TEXT_BYTES ? `Message is ${bytes} bytes; the limit is ${MAX_TEXT_BYTES}.` : "Write a message before review.";
      error.hidden = false;
      return;
    }
    textarea.hidden = true;
    label.hidden = true;
    count.hidden = true;
    persistRow.hidden = true;
    reviewText.textContent = textarea.value;
    review.hidden = false;
    actionRow.replaceChildren(editButton, sendButton);
  });

  editButton.addEventListener("click", () => {
    textarea.hidden = false;
    label.hidden = false;
    count.hidden = false;
    persistRow.hidden = false;
    review.hidden = true;
    actionRow.replaceChildren(reviewButton);
    textarea.focus();
  });

  sendButton.addEventListener("click", async () => {
    const run = ++currentRun;
    sendButton.disabled = true;
    sendButton.textContent = "Running verified fixture…";
    error.hidden = true;
    try {
      const result = await executeLoopback({
        senderId: sender.select.value,
        recipientId: recipient.select.value,
        plaintextBytes: encoder.encode(textarea.value),
      });
      if (!isCurrent(run)) return;
      const recovered = new TextDecoder("utf-8", { fatal: true }).decode(result.plaintextBytes);
      const message = {
        senderId: sender.select.value,
        recipientId: recipient.select.value,
        body: recovered,
        messageId: result.messageId,
        batchId: result.batchId,
        receivedAt: result.receivedAt,
        evidence: result.evidence.map(({ code }) => ({ code })),
      };
      model.inbox = [message, ...model.inbox.filter((item) => item.messageId !== message.messageId)].slice(0, MAX_MESSAGES);
      if (model.persist) await appContext.storage.local.set({ [STATE_KEY]: { version: 1, inbox: model.inbox } });
      if (!isCurrent(run)) return;
      inboxTab.textContent = `Inbox (${model.inbox.length})`;
      renderResult(content, model, message);
      appContext.recordDiagnostic("blobmail-loopback.fixture", {
        reconstructed: true,
        decrypted: true,
        broadcast: false,
        persisted: model.persist,
      });
    } catch (failure) {
      if (!isCurrent(run)) return;
      error.textContent = failure instanceof Error ? failure.message : "The local fixture failed.";
      error.hidden = false;
      sendButton.disabled = false;
      sendButton.textContent = "Send to local batch";
    }
  });

  review.append(el("span", "blobmail-sdk-eyebrow", "REVIEW · NO BROADCAST"), reviewText, proof);
  form.append(route, label, textarea, count, persistRow, review, error, actionRow);
  content.append(form);
}

function renderResult(content, model, message) {
  content.replaceChildren();
  const result = el("div", "blobmail-sdk-result");
  result.append(el("span", "blobmail-sdk-success", "RECONSTRUCTED + DECRYPTED"));
  result.append(el("p", "blobmail-sdk-message", message.body));
  const timeline = el("ol", "blobmail-sdk-timeline");
  for (const item of message.evidence) {
    const row = el("li");
    row.append(el("strong", "", item.code.replaceAll("_", " ")));
    timeline.append(row);
  }
  result.append(timeline, el("p", "blobmail-sdk-footnote", "Decrypted is not delivered, read, acknowledged, settled, or canonically included."));
  const again = button("Compose another fixture", "Compose another", "blobmail-sdk-primary");
  again.addEventListener("click", () => renderCompose(content, model, panel.querySelector(".blobmail-sdk-nav button:nth-child(2)")));
  result.append(again);
  content.append(result);
}

function renderInbox(content, model) {
  content.replaceChildren();
  const wrapper = el("div", "blobmail-sdk-inbox");
  if (model.inbox.length === 0) {
    wrapper.append(el("p", "blobmail-sdk-empty", "No local fixture messages. Persistence is off by default."));
  } else {
    for (const message of model.inbox) {
      const card = el("article", "blobmail-sdk-card");
      card.append(el("span", "blobmail-sdk-eyebrow", `${message.senderId.toUpperCase()} → ${message.recipientId.toUpperCase()}`));
      card.append(el("p", "blobmail-sdk-message", message.body));
      card.append(el("code", "", message.batchId));
      wrapper.append(card);
    }
  }
  const clearButton = button("Clear local fixture data", "Clear local fixture data");
  clearButton.addEventListener("click", async () => {
    if (!appContext || appContext.signal.aborted) return;
    await appContext.storage.local.remove(STATE_KEY);
    if (!appContext || appContext.signal.aborted) return;
    model.inbox = [];
    renderInbox(content, model);
  });
  wrapper.append(clearButton);
  content.append(wrapper);
}

function selectIdentity(labelText, selected) {
  const label = el("label", "blobmail-sdk-label", labelText);
  const select = document.createElement("select");
  select.setAttribute("aria-label", `${labelText} fixture identity`);
  for (const id of ["alice", "bob"]) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id[0].toUpperCase() + id.slice(1);
    option.selected = id === selected;
    select.append(option);
  }
  return { label, select };
}

function el(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label, text, className = "") {
  const node = el("button", className, text);
  node.type = "button";
  node.setAttribute("aria-label", label);
  return node;
}

function removePanel() {
  panel?.remove();
  panel = null;
  if (previousFocus?.isConnected) previousFocus.focus();
  previousFocus = null;
}
