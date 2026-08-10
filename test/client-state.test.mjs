import assert from "node:assert/strict";
import test from "node:test";

import { MAX_INBOX_MESSAGES, MAX_MESSAGE_BYTES } from "../src/client/constants.js";
import {
  beginSend,
  createInitialState,
  finishSend,
  openReview,
  setDraftBody,
  showComposer,
  showInbox,
  showSent,
  signIn,
  signOut,
  utf8ByteLength,
  validateDraft,
} from "../src/client/state.js";

test("compose state validates UTF-8 bytes instead of JavaScript characters", () => {
  const exact = "🫧".repeat(MAX_MESSAGE_BYTES / 4);
  const tooLarge = `${exact}a`;

  assert.equal(utf8ByteLength(exact), MAX_MESSAGE_BYTES);
  assert.deepEqual(validateDraft({ body: exact, recipientId: "bob" }), {
    ok: true,
    bytes: MAX_MESSAGE_BYTES,
  });
  assert.equal(validateDraft({ body: tooLarge, recipientId: "bob" }).ok, false);
});

test("review is a required explicit state before local batch submission", () => {
  let state = signIn(createInitialState(), "alice");
  state = setDraftBody(state, "hello from Alice");
  assert.equal(beginSend(state), state);

  state = showComposer(state);
  assert.equal(beginSend(state).view, "compose");

  state = openReview(state);
  assert.equal(state.view, "review");
  state = beginSend(state);
  assert.equal(state.view, "sending");
});

test("successful loopback moves the reconstructed message into Bob's bounded inbox", () => {
  let state = openReview(setDraftBody(signIn(createInitialState(), "alice"), "blob hello"));
  state = beginSend(state);
  const evidence = [
    "LOCAL_BATCH_CREATED",
    "BATCH_RECONSTRUCTED",
    "ENTRY_BYTES_VERIFIED",
    "DECRYPTED",
  ].map((code) => ({ code, detail: "ok", status: "verified" }));

  for (let index = 0; index < MAX_INBOX_MESSAGES + 2; index += 1) {
    state = {
      ...state,
      activeIdentity: "alice",
      signedIn: true,
      view: "sending",
      draft: { recipientId: "bob", body: `message ${index}` },
    };
    state = finishSend(state, {
      messageId: `message-${index}`,
      batchId: `batch-${index}`,
      receivedAt: "2026-08-10T00:00:00.000Z",
      plaintextBytes: new TextEncoder().encode(`message ${index}`),
      evidence,
      receipt: {},
    });
  }

  assert.equal(state.activeIdentity, "alice");
  assert.equal(state.view, "sent");
  assert.equal(state.inbox.length, MAX_INBOX_MESSAGES);
  assert.equal(state.inbox[0].body, `message ${MAX_INBOX_MESSAGES + 1}`);
  assert.equal(state.inbox.filter(({ senderId }) => senderId === "alice").length, MAX_INBOX_MESSAGES);

  state = signOut(state);
  state = signIn(state, "bob");
  state = showInbox(state);
  assert.equal(state.view, "inbox");
  assert.equal(state.inbox.filter(({ recipientId }) => recipientId === "bob").length, MAX_INBOX_MESSAGES);
});

test("local profile sign-in and switch reset drafts without persisting an authenticated session", () => {
  let state = createInitialState({ activeIdentity: "alice", draftBody: "restored draft" });
  assert.equal(state.signedIn, false);
  assert.equal(state.view, "signin");

  state = signIn(state, "bob");
  assert.equal(state.activeIdentity, "bob");
  assert.equal(state.signedIn, true);
  assert.equal(state.view, "inbox");
  assert.deepEqual(state.draft, { body: "", recipientId: "alice" });

  state = setDraftBody(state, "unsent local text");
  state = signOut(state);
  assert.equal(state.signedIn, false);
  assert.equal(state.view, "signin");
  assert.deepEqual(state.draft, { body: "", recipientId: "alice" });

  state = { ...state, view: "sending" };
  assert.equal(signIn(state, "alice"), state);
  assert.equal(signOut(state), state);
});

test("Inbox and Sent navigation require a selected local fixture profile", () => {
  const signedOut = createInitialState();
  assert.equal(showInbox(signedOut), signedOut);
  assert.equal(showSent(signedOut), signedOut);

  const signedInState = signIn(signedOut, "alice");
  assert.equal(showSent(signedInState).view, "sent");
  assert.equal(showInbox(showSent(signedInState)).view, "inbox");
});
