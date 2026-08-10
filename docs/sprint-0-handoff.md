# BlobMail Sprint 0 handoff

Sprint 0 implements a local, replayable BlobMail text-message loop and its
first browser client. GitHub issue
[`bonklek/blobmail#3`](https://github.com/bonklek/blobmail/issues/3) is the
shared work ticket; Papertiger is the local execution ledger.

## Reproduce

```sh
pnpm install --frozen-lockfile
pnpm dev
```

With the development server running at `http://127.0.0.1:5173`, run:

```sh
pnpm verify
pnpm probe:client
pnpm reports
```

The UI uses only deterministic fixture identities. Compose as Alice, review,
send to Bob, and inspect the ordered evidence timeline and receipt. Refreshing
the page restores the bounded inbox from local storage.

## Design choices

- V0 is text-only and uses a fixed 512-byte plaintext class.
- HPKE base mode uses X25519/HKDF-SHA-256 and AES-128-GCM.
- The recipient tag is an HPKE exporter value, not a public-key hash.
- Entries and batches have canonical framing, ordering, and SHA-256 IDs.
- Blob packing stores 31 payload bytes per field element and checks prefixes.
- The client integrates through a narrow milXdy-compatible adapter boundary.
- Public eth-radio RFE concepts were adapted with exact source provenance.

The transport source is public `bonklek/eth-radio` commit
`b465e02f88bbca85932344228c1cfe5abfb51253`; exact upstream files, Git blob
IDs, local hashes, and license text are recorded in
`docs/rfe-transport-provenance.md` and `THIRD_PARTY_NOTICES.md`.

## Proof map

- `reports/sprint-0-acceptance.json`: machine-readable acceptance index
- `reports/test-results.xml`: full executable test receipt
- `reports/protocol-core-tests.json`: protocol and verifier coverage
- `reports/browser-loopback.json`: running-client and DOM-loop evidence
- `reports/sprint-0-adversarial.json`: negative-case coverage
- `reports/safety-audit.json`: prohibited-capability scan
- `reports/no-broadcast-audit.json`: RFE transport capability audit
- `vectors/blobmail-v0.json`: deterministic golden fixture

## Known limits

All transport is in memory. There is no wallet, funded key, signing,
transaction construction, transaction or bundle submission, live sidecar
retrieval, KZG proof verification, or chain inclusion. HPKE base mode provides
no authenticated-sender provenance. `reconstructed`, `entry verified`, and
`decrypted` remain separate states; none means delivered, read, acknowledged,
or settled.

The in-app visual browser backend was unavailable during this run. The client
was covered by state/storage/adapter tests, an integrated DOM interaction test,
a production build, and an HTTP probe of the running Vite development server;
no visual-pass claim is made.

## Next-sprint cut line

The broader protocol epic remains
[`bonklek/blobmail#2`](https://github.com/bonklek/blobmail/issues/2). Live
milXdy work remains behind its existing platform issues: read-only provider
policy [#136](https://github.com/bonklek/milXdy/issues/136), background service
[#137](https://github.com/bonklek/milXdy/issues/137), RFE playback
[#139](https://github.com/bonklek/milXdy/issues/139), package SDK boundary
[#148](https://github.com/bonklek/milXdy/issues/148), evidence/storage
[#149](https://github.com/bonklek/milXdy/issues/149), and key transparency
[#150](https://github.com/bonklek/milXdy/issues/150). These are not silently
expanded into Sprint 0.

Live publishing, recipient-key registry enrollment, authenticated senders,
AA/paymasters, Paraclete transport, settlement, attachments, and production
privacy need separate agent-ready implementation tickets before work begins.
