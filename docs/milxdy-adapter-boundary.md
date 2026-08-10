# milXdy adapter boundary for BlobMail Loopback

Status: first-pass, fixture-only integration design (2026-08-09)

This document defines the narrow seam between the standalone BlobMail Sprint 0
client and a future reviewed milXdy App SDK package. It intentionally does not
design a wallet, RPC, key registry, background receiver, or transaction path.

## What Sprint 0 can contribute

The standalone client contributes feature-owned pieces that do not depend on
milXdy internals:

- the compose -> review -> explicit local-batch action;
- strict 480-byte UTF-8 text bounds matching the frozen V0 text profile;
- deterministic Alice and Bob test identities;
- inert text-only inbox rendering;
- distinct reconstruction, byte-verification, and decryption evidence;
- bounded persistence sanitization and deterministic 12-message eviction; and
- the adapter contract in `src/client/adapter.js`.

The browser shell's `localStorage` use is only a standalone development
mechanism. It stores plaintext draft and decrypted fixture messages under
`blobmail.loopback.client.v1`, limits serialized state to 32 KiB, and exposes a
clear action. It is not suitable for production messaging keys or a real
milXdy inbox.

## Client adapter contract

The UI does not import protocol or transport modules. The host injects one
function through `createClientAdapter({ executeLoopback })`:

```js
await executeLoopback({
  senderId: "alice",
  recipientId: "bob",
  plaintextBytes: Uint8Array,
});
```

The function returns:

```js
{
  messageId: String,
  batchId: String,
  receivedAt: ISO8601String,
  plaintextBytes: Uint8Array, // bytes recovered by decryption, not input echo
  evidence: [
    { code: "LOCAL_BATCH_CREATED", detail: String },
    { code: "BATCH_RECONSTRUCTED", detail: String },
    { code: "ENTRY_BYTES_VERIFIED", detail: String },
    { code: "DECRYPTED", detail: String },
  ],
  receipt: Object,
}
```

Additional transport evidence such as `SIDECARS_MATCHED` and
`PAYLOAD_SHA256_VERIFIED` may appear between the required states. The adapter
rejects missing, reordered, invalid-time, invalid-byte, and invalid-UTF-8
results. The UI never derives a `delivered`, `read`, `acknowledged`, `settled`,
or `included` state from these local proofs.

The `createPreviewAdapter()` implementation exists only so the unintegrated UI
can be inspected. Its banner says encryption is not executed and every
timeline item is marked `PREVIEW - NOT EXECUTED`. It must not ship as a milXdy
runtime adapter.

## App SDK ownership split

The current [milXdy App SDK reference][sdk] says app packages own feature code
and UI while the platform owns lifecycle, shared scanning, scheduling,
network policy, app chrome, diagnostics, and package trust. A BlobMail package
should preserve that split:

| Concern | BlobMail package | milXdy platform |
| --- | --- | --- |
| Composer, inbox, evidence presentation | Own | Frame and theme only |
| Canonical encryption/batch/scanning library | Own, reviewed dependency | Validate package/build provenance |
| Dock open/close and app disposal | Implement hooks | Invoke hooks and abort signal |
| State | Request only declared keys | Guard `context.storage.local` access |
| Delayed work | Describe bounded jobs | Provide `context.scheduler` and cancellation |
| Chain reads in a later phase | Consume typed service | Own provider policy, limits, redaction |
| Page scanning | None for fixture client | Shared runtime owns scanners |
| Network, wallet, signing, transactions | None in this phase | No capability requested |

The fixture-only package should be an optional docked `app` with an
`overlayApp` surface and a `dockOpen` load trigger. It should use runtime-owned
lifecycle hooks, `context.signal`, declared app-scoped storage, and the shared
overlay frame. It should not install a MutationObserver, timer-based receiver,
page scanner, service worker, or direct `chrome.storage` bypass.

Initial manifest disclosure should state:

- local deterministic fixture processing only;
- no remote service or host permission;
- no wallet-address, signature, transaction, token, AA, or P2P capability;
- plaintext draft and decrypted local fixture storage, with the exact bounds;
- no production privacy or availability claim; and
- app-owned reset removes all declared BlobMail fixture keys.

## Replacement seams for the real app

The milXdy package can reuse the client state transitions and views, but it
must replace these standalone services:

1. Replace `window.localStorage` with a storage object backed by declared
   `context.storage.local` keys. Keep sanitization, versioning, bounds, clear,
   and corruption fallback. Production inbox encryption is later work.
2. Replace `createPreviewAdapter()` with `createClientAdapter()` around the
   closed protocol and verified RFE-derived receiver kernel.
3. Map lifecycle cancellation to `context.signal`. A late reconstruction must
   not write state after disable, dispose, route-context change, or clear.
4. Route bounded background/read-only data work through platform services only
   after their capability and provider policies exist.
5. Use the shared dock, overlay frame, panel theme, geometry persistence, and
   diagnostics. Do not copy those platform internals into BlobMail.

## Roadmap dependencies

- [#136 - Define onchain app capabilities and permission disclosures][i136]
  is required before BlobMail asks for passive chain reads, encrypted key
  storage, P2P, signatures, or submission. The fixture app should request none.
- [#137 - Build shared chain, RPC, and wallet action lifecycle services][i137]
  supplies future bounded/cancellable RPC, provider provenance, redaction, and
  stale-result controls. The fixture app must not create an interim provider.
- [#139 - Add RFE station discovery and verified read-only playback][i139]
  establishes the reusable read-only RFE verification, availability, cache,
  provider, and reorg semantics. BlobMail reuses the verified receiver-kernel
  boundary, not station UI, publishing, wallet, or media playback code.
- [#148 - Build a BlobMail testnet inbox and message composer][i148] owns the
  eventual milXdy app. Sprint 0 proves only its text/fixture round trip and
  explicit-review UX; testnet, attachments, key resolution, cost choices, and
  restart recovery remain gated.
- [#149 - Add BlobMail identity enrollment and key transparency][i149]
  replaces Alice/Bob fixtures with local messaging-key lifecycle and observed
  registry provenance. It must not silently link X, RemiNet, wallet, and
  BlobMail identities.
- [#150 - Implement BlobMail delivery evidence, storage, and recovery][i150]
  owns the complete evidence model and bounded encrypted inbox/outbox. Sprint 0
  deliberately implements only local batch reconstruction, byte verification,
  decryption, bounded plaintext fixture storage, and deletion.

## Explicitly deferred

No part of this boundary authorizes testnet/mainnet publication, wallet
connection, signing, funded keys, AA/paymasters, bundles, Paraclete/gossip,
live recipient lookup, registry writes, remote notifications, receipts,
attachments, active content, archive calls, or background network polling.

[sdk]: https://github.com/bonklek/milXdy/blob/main/docs/sdk/APP_SDK.md
[i136]: https://github.com/bonklek/milXdy/issues/136
[i137]: https://github.com/bonklek/milXdy/issues/137
[i139]: https://github.com/bonklek/milXdy/issues/139
[i148]: https://github.com/bonklek/milXdy/issues/148
[i149]: https://github.com/bonklek/milXdy/issues/149
[i150]: https://github.com/bonklek/milXdy/issues/150
