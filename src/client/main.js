import { IDENTITIES, MAX_MESSAGE_BYTES } from "./constants.js";
import {
  beginSend,
  createInitialState,
  failSend,
  finishSend,
  openReview,
  returnToCompose,
  selectIdentity,
  setDraftBody,
  showComposer,
  showInbox,
  utf8ByteLength,
} from "./state.js";
import { clearClientState, loadClientState, saveClientState } from "./storage.js";

const evidenceLabels = Object.freeze({
  LOCAL_BATCH_CREATED: ["Local batch created", "Encrypted entry packed into a local batch."],
  SIDECARS_MATCHED: ["Sidecars matched", "Fixture sidecars matched their versioned hashes."],
  BATCH_RECONSTRUCTED: ["Batch reconstructed", "Payload bytes reconstructed from the blob fixture."],
  PAYLOAD_SHA256_VERIFIED: ["Payload digest verified", "Reconstructed payload digest matched the manifest."],
  ENTRY_BYTES_VERIFIED: ["Entry bytes verified", "Canonical encrypted entry bytes passed integrity checks."],
  DECRYPTED: ["Decrypted", "The matching recipient recovered strict UTF-8 text."],
});

const icon = (name) => {
  const paths = {
    compose: '<path d="M4 20h4L19 9l-4-4L4 16v4Zm10-13 4 4"/>',
    inbox: '<path d="M4 5h16v14H4zM4 14h4l2 2h4l2-2h4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    shield: '<path d="M12 3 5 6v5c0 4.5 2.8 8.1 7 10 4.2-1.9 7-5.5 7-10V6l-7-3Zm-3 9 2 2 4-5"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/>',
    arrow: '<path d="m9 18 6-6-6-6"/>',
    lock: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name]}</svg>`;
};

function shellMarkup(adapter) {
  const preview = adapter.runtime.mode === "preview";
  return `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand" aria-label="BlobMail">
          <span class="brand-mark"><i></i><i></i><i></i></span>
          <span><strong>BlobMail</strong><small>LOOPBACK / 0</small></span>
        </div>

        <nav class="primary-nav" aria-label="Mailbox">
          <button class="nav-item active" data-action="compose">${icon("compose")}<span>Compose</span></button>
          <button class="nav-item" data-action="inbox">${icon("inbox")}<span>Local inbox</span><b data-inbox-count>0</b></button>
        </nav>

        <div class="sidebar-spacer"></div>
        <section class="safety-card">
          <span class="safety-icon">${icon("shield")}</span>
          <div><strong>Local evidence lab</strong><p>No wallet, network, transaction, or public delivery.</p></div>
        </section>
        <button class="clear-button" data-action="clear">${icon("trash")} Clear local data</button>
      </aside>

      <main class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">FIXTURE-ONLY CLIENT</p>
            <h1 data-page-title>New local message</h1>
          </div>
          <div class="identity-switch" role="group" aria-label="Test identity">
            <span>Acting as</span>
            <button data-identity="alice" aria-pressed="true"><i class="avatar coral">A</i>Alice</button>
            <button data-identity="bob" aria-pressed="false"><i class="avatar violet">B</i>Bob</button>
          </div>
        </header>

        <div class="runtime-banner ${preview ? "preview" : "verified"}" role="status">
          <span class="runtime-dot"></span>
          <strong>${preview ? "UI preview only" : "Loopback engine connected"}</strong>
          <span>${preview ? "Encryption and reconstruction are not executed in this standalone preview." : "Messages execute only against deterministic, local fixtures."}</span>
        </div>

        <section class="panel compose-panel" data-view="compose">
          <div class="panel-heading">
            <div><p class="step-label">STEP 1 OF 2</p><h2>Compose</h2></div>
            <span class="plain-badge">TEXT ONLY</span>
          </div>
          <div class="address-row">
            <span>From</span><div data-from-chip></div>
            <span class="route-line"></span>
            <span>To</span><div data-to-chip></div>
          </div>
          <label class="message-label" for="message-body">Message</label>
          <textarea id="message-body" rows="9" placeholder="Write a short message for the local loopback…" spellcheck="true"></textarea>
          <div class="composer-meta">
            <span>Decrypted text is treated as untrusted and rendered inertly.</span>
            <span data-byte-count>0 / ${MAX_MESSAGE_BYTES} bytes</span>
          </div>
          <p class="error-message" data-error hidden></p>
          <div class="panel-actions">
            <span class="local-note">${icon("lock")} Saved as bounded plaintext in this browser</span>
            <button class="primary-button" data-action="review">Review message ${icon("arrow")}</button>
          </div>
        </section>

        <section class="panel review-panel" data-view="review" hidden>
          <div class="panel-heading">
            <div><p class="step-label">STEP 2 OF 2</p><h2>Review local batch</h2></div>
            <span class="plain-badge">NO BROADCAST</span>
          </div>
          <div class="review-route"><div data-review-from></div><span>${icon("arrow")}</span><div data-review-to></div></div>
          <div class="review-message"><span>MESSAGE · <b data-review-bytes></b></span><p data-review-body></p></div>
          <div class="expectation">
            <strong>What this action proves</strong>
            <p>The connected engine must encrypt, pack, reconstruct, verify, scan, and decrypt these bytes. It does not prove public availability or delivery.</p>
          </div>
          <p class="error-message" data-error hidden></p>
          <div class="panel-actions split">
            <button class="secondary-button" data-action="edit">Back to edit</button>
            <button class="primary-button" data-action="send"><span data-send-label>Send to local batch</span>${icon("arrow")}</button>
          </div>
        </section>

        <section data-view="inbox" hidden>
          <div class="inbox-layout">
            <div class="panel inbox-panel">
              <div class="panel-heading"><div><p class="step-label">LOCAL-ONLY</p><h2>Reconstructed inbox</h2></div></div>
              <div class="inbox-list" data-inbox-list></div>
            </div>
            <aside class="panel evidence-panel">
              <div class="panel-heading compact"><div><p class="step-label">LATEST RUN</p><h2>Evidence</h2></div></div>
              <div class="evidence-list" data-evidence-list></div>
              <p class="evidence-footnote">“Decrypted” is local cryptographic evidence. It is not a delivery receipt, acknowledgement, settlement, or onchain inclusion claim.</p>
            </aside>
          </div>
          <button class="primary-button compose-again" data-action="compose">${icon("compose")} Compose another</button>
        </section>

        <footer><span>BlobMail Loopback · Development surface</span><span>Stored locally · 12 messages maximum · 32 KiB state ceiling</span></footer>
      </main>
    </div>`;
}

function createIdentityChip(identity, suffix = "") {
  const chip = document.createElement("div");
  chip.className = "identity-chip";
  const avatar = document.createElement("i");
  avatar.className = `avatar ${identity.color}`;
  avatar.textContent = identity.monogram;
  const copy = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = identity.name + suffix;
  const fingerprint = document.createElement("small");
  fingerprint.textContent = identity.fingerprint;
  copy.append(name, fingerprint);
  chip.append(avatar, copy);
  return chip;
}

function replaceContent(node, child) {
  node.replaceChildren(child);
}

function evidenceNode(item) {
  const row = document.createElement("div");
  row.className = `evidence-item ${item.status === "preview" ? "preview" : "verified"}`;
  const marker = document.createElement("span");
  marker.className = "evidence-marker";
  marker.innerHTML = item.status === "preview" ? "·" : icon("check");
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  const mapped = evidenceLabels[item.code];
  title.textContent = mapped?.[0] ?? item.code.replaceAll("_", " ");
  const detail = document.createElement("p");
  detail.textContent = item.detail || mapped?.[1] || "Evidence recorded by the local engine.";
  const code = document.createElement("code");
  code.textContent = item.status === "preview" ? "PREVIEW · NOT EXECUTED" : item.code;
  copy.append(title, detail, code);
  row.append(marker, copy);
  return row;
}

function emptyInboxNode(identity) {
  const empty = document.createElement("div");
  empty.className = "empty-inbox";
  const mark = document.createElement("span");
  mark.innerHTML = icon("inbox");
  const title = document.createElement("strong");
  title.textContent = `${identity.name}’s local inbox is empty`;
  const body = document.createElement("p");
  body.textContent = "Compose a bounded message and run it through the local batch fixture.";
  empty.append(mark, title, body);
  return empty;
}

function inboxMessageNode(message, isLatest) {
  const article = document.createElement("article");
  article.className = `message-card${isLatest ? " latest" : ""}`;
  const header = document.createElement("header");
  header.append(createIdentityChip(IDENTITIES[message.senderId]));
  const time = document.createElement("time");
  time.dateTime = message.receivedAt;
  time.textContent = new Date(message.receivedAt).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  header.append(time);
  const body = document.createElement("p");
  body.className = "message-body";
  body.textContent = message.body;
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const state = document.createElement("span");
  const preview = message.evidence.some((item) => item.status === "preview");
  state.className = preview ? "preview-state" : "verified-state";
  state.textContent = preview ? "Preview reconstruction" : "Reconstructed + decrypted";
  const batch = document.createElement("code");
  batch.textContent = message.batchId;
  meta.append(state, batch);
  article.append(header, body, meta);
  return article;
}

export function startBlobMailClient({
  root = document.querySelector("#app"),
  adapter,
  storage = globalThis.localStorage,
} = {}) {
  if (!root) throw new Error("BlobMail client root was not found.");
  if (!adapter?.sendToLocalBatch) throw new TypeError("A BlobMail client adapter is required.");

  root.innerHTML = shellMarkup(adapter);
  let state = createInitialState(loadClientState(storage) ?? {});

  const refs = {
    views: [...root.querySelectorAll("[data-view]")],
    title: root.querySelector("[data-page-title]"),
    textarea: root.querySelector("#message-body"),
    byteCount: root.querySelector("[data-byte-count]"),
    from: root.querySelector("[data-from-chip]"),
    to: root.querySelector("[data-to-chip]"),
    reviewFrom: root.querySelector("[data-review-from]"),
    reviewTo: root.querySelector("[data-review-to]"),
    reviewBody: root.querySelector("[data-review-body]"),
    reviewBytes: root.querySelector("[data-review-bytes]"),
    errors: [...root.querySelectorAll("[data-error]")],
    inboxList: root.querySelector("[data-inbox-list]"),
    evidenceList: root.querySelector("[data-evidence-list]"),
    inboxCount: root.querySelector("[data-inbox-count]"),
    identityButtons: [...root.querySelectorAll("[data-identity]")],
    navButtons: [...root.querySelectorAll(".nav-item")],
    sendButton: root.querySelector('[data-action="send"]'),
    sendLabel: root.querySelector("[data-send-label]"),
  };

  function commit(next, { persist = true } = {}) {
    state = next;
    if (persist) saveClientState(storage, state);
    render();
  }

  function render() {
    const sender = IDENTITIES[state.activeIdentity];
    const recipient = IDENTITIES[state.draft.recipientId];
    const activeView = state.view === "sending" ? "review" : state.view;
    refs.views.forEach((view) => {
      view.hidden = view.dataset.view !== activeView;
    });
    refs.title.textContent = activeView === "inbox" ? `${sender.name}’s local inbox` : "New local message";
    refs.navButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.action === (activeView === "inbox" ? "inbox" : "compose"));
    });
    refs.identityButtons.forEach((button) => {
      const active = button.dataset.identity === state.activeIdentity;
      button.setAttribute("aria-pressed", String(active));
    });

    refs.textarea.value = state.draft.body;
    const draftBytes = utf8ByteLength(state.draft.body);
    refs.byteCount.textContent = `${draftBytes} / ${MAX_MESSAGE_BYTES} bytes`;
    refs.byteCount.classList.toggle("over-limit", draftBytes > MAX_MESSAGE_BYTES);
    replaceContent(refs.from, createIdentityChip(sender));
    replaceContent(refs.to, createIdentityChip(recipient));
    replaceContent(refs.reviewFrom, createIdentityChip(sender));
    replaceContent(refs.reviewTo, createIdentityChip(recipient));
    refs.reviewBody.textContent = state.draft.body;
    refs.reviewBytes.textContent = `${draftBytes} BYTES`;
    refs.errors.forEach((error) => {
      error.hidden = !state.error;
      error.textContent = state.error ?? "";
    });
    refs.sendButton.disabled = state.view === "sending";
    refs.sendLabel.textContent = state.view === "sending" ? "Running local loopback…" : "Send to local batch";

    const ownInbox = state.inbox.filter((message) => message.recipientId === state.activeIdentity);
    refs.inboxCount.textContent = String(ownInbox.length);
    refs.inboxCount.hidden = ownInbox.length === 0;
    refs.inboxList.replaceChildren(
      ...(ownInbox.length
        ? ownInbox.map((message) => inboxMessageNode(message, message.id === state.latestMessageId))
        : [emptyInboxNode(sender)]),
    );
    refs.evidenceList.replaceChildren(
      ...(state.evidence.length
        ? state.evidence.map(evidenceNode)
        : [
            (() => {
              const empty = document.createElement("p");
              empty.className = "no-evidence";
              empty.textContent = "Run a local message to produce an evidence timeline.";
              return empty;
            })(),
          ]),
    );
  }

  root.addEventListener("input", (event) => {
    if (event.target === refs.textarea) commit(setDraftBody(state, event.target.value));
  });

  root.addEventListener("click", async (event) => {
    const identityButton = event.target.closest("[data-identity]");
    if (identityButton) {
      commit(selectIdentity(state, identityButton.dataset.identity));
      return;
    }
    const button = event.target.closest("[data-action]");
    if (!button) return;
    switch (button.dataset.action) {
      case "compose":
        commit(showComposer(state));
        break;
      case "inbox":
        commit(showInbox(state));
        break;
      case "review":
        commit(openReview(state));
        break;
      case "edit":
        commit(returnToCompose(state));
        break;
      case "clear":
        if (globalThis.confirm?.("Clear the bounded BlobMail draft and local inbox?")) {
          clearClientState(storage);
          commit(createInitialState({ activeIdentity: state.activeIdentity }), { persist: false });
        }
        break;
      case "send": {
        if (state.view !== "review") break;
        const request = {
          senderId: state.activeIdentity,
          recipientId: state.draft.recipientId,
          plaintextBytes: new TextEncoder().encode(state.draft.body),
        };
        commit(beginSend(state));
        try {
          const result = await adapter.sendToLocalBatch(request);
          commit(finishSend(state, result));
        } catch (error) {
          commit(failSend(state, error));
        }
        break;
      }
    }
  });

  render();
  return Object.freeze({ getState: () => state });
}
