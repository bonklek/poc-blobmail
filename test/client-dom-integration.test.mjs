import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";

import { createClientAdapter } from "../src/client/adapter.js";
import { startBlobMailClient } from "../src/client/main.js";
import { executeLoopback } from "../src/integration/loopback.js";

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for client state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("browser client drives the verified protocol and blob loopback into the inbox", async () => {
  const window = new Window({ url: "http://127.0.0.1:5173/" });
  globalThis.document = window.document;
  const root = window.document.createElement("div");
  root.id = "app";
  window.document.body.append(root);
  window.confirm = () => true;

  const adapter = createClientAdapter({
    executeLoopback,
    runtimeLabel: "Verified local BlobMail loopback",
  });
  const client = startBlobMailClient({ root, adapter, storage: window.localStorage });
  assert.equal(client.getState().signedIn, false);
  assert.match(root.textContent, /Sign in to BlobMail/);

  root.querySelector('[data-sign-in="alice"]').click();
  assert.equal(client.getState().activeIdentity, "alice");
  assert.equal(client.getState().view, "inbox");
  root.querySelector('[data-action="compose"]').click();

  const textarea = root.querySelector("#message-body");
  textarea.value = "hello from the first running BlobMail client";
  textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  root.querySelector('[data-action="review"]').click();
  assert.equal(client.getState().view, "review");
  root.querySelector('[data-action="send"]').click();

  await waitFor(() => client.getState().view === "sent");
  const state = client.getState();
  assert.equal(state.activeIdentity, "alice");
  assert.equal(state.inbox.length, 1);
  assert.equal(state.inbox[0].body, "hello from the first running BlobMail client");
  assert.deepEqual(
    state.evidence.map(({ code }) => code),
    [
      "LOCAL_BATCH_CREATED",
      "BATCH_RECONSTRUCTED",
      "PAYLOAD_SHA256_VERIFIED",
      "ENTRY_BYTES_VERIFIED",
      "DECRYPTED",
    ],
  );
  assert.match(root.textContent, /Local sent copy - reconstructed/);
  assert.match(root.textContent, /hello from the first running BlobMail client/);
  assert.equal(state.inbox[0].receipt.broadcast, false);
  assert.equal(state.inbox[0].receipt.chainIncluded, false);

  root.querySelector('[data-action="switch-account"]').click();
  assert.equal(client.getState().signedIn, false);
  root.querySelector('[data-sign-in="bob"]').click();
  assert.equal(client.getState().activeIdentity, "bob");
  assert.equal(client.getState().view, "inbox");
  assert.match(root.textContent, /Reconstructed \+ decrypted/);

  const restoredRoot = window.document.createElement("div");
  const restored = startBlobMailClient({ root: restoredRoot, adapter, storage: window.localStorage });
  assert.equal(restored.getState().signedIn, false);
  assert.equal(restored.getState().inbox[0].body, state.inbox[0].body);
  restoredRoot.querySelector('[data-sign-in="bob"]').click();
  assert.match(restoredRoot.textContent, /hello from the first running BlobMail client/);
  await window.happyDOM.abort();
});
