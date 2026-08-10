# BlobMail Sprint 0 agent prompt

Work issue: <https://github.com/bonklek/blobmail/issues/3>

## Objective

Bring up a local first-pass BlobMail client that can compose a bounded text
message, encrypt it to an ephemeral test recipient, pack the canonical entry
into a local Ethereum-blob-shaped fixture, reconstruct and verify the batch,
scan and decrypt the matching entry, and persist a bounded local inbox with
honest evidence states.

The result must be executable and replayable. Architecture prose without the
working browser loop is incomplete.

## Required operating loop

1. Begin each session with Papertiger `status`, `focus --json`, and `audit`.
2. Work only on the focused task or a dependency-unlocking child.
3. Record standalone `--why` text for Papertiger mutations.
4. Close gates only with repository-relative evidence plus SHA-256.
5. Run the affected tests after every integration change.
6. Do not mark the goal complete until `pnpm verify` passes and the browser
   client is started and probed through its documented local URL.

## Parallel ownership

- Protocol agent owns `src/protocol/**`, protocol tests, normative protocol
  docs, vector generation, and crypto/encoding receipts.
- Transport agent owns `src/transport/**`, transport tests, RFE provenance,
  third-party notices, and the no-broadcast audit.
- Client agent owns `index.html`, `src/client/**`, client tests, UX assets, and
  the milXdy adapter-boundary document.
- The primary agent owns package metadata/lockfiles, integration glue,
  Papertiger, GitHub state, final QA, and acceptance receipts.

Agents must not edit outside their ownership without first coordinating with
the primary agent. Never overwrite another agent's changes.

## Reuse and provenance

Adapt the minimum required implementation from the public
`bonklek/eth-radio` repository, pinning the exact source commit and file paths.
Preserve applicable license notices. Do not use, inspect for code reuse, or
depend on `eth-radio-private-unsafe-history`.

The reusable RFE concepts are field-element blob packing, versioned-hash
matching, reconstruction, payload digest verification, bounded cache behavior,
and provider/archive evidence distinctions. Publishing and wallet code are
outside the reusable boundary.

## Safety boundary

- Local fixtures and read-only replay only.
- No transaction broadcasting, private transactions, bundle submission,
  funded keys, wallet connection, signing, or secret requests.
- No ERC-4337, paymasters, Paraclete, registry publication, live recipient
  lookup, settlement, or production anonymity claims.
- Text-only bounded content. Decrypted bytes are untrusted and rendered as
  text only after strict decoding and bounds validation.
- Do not label reconstructed, entry-verified, decrypted, read, settled, or
  acknowledged states as equivalent.

## Definition of running

- `pnpm verify` succeeds from a clean dependency install.
- `pnpm dev` starts a local browser client.
- Two deterministic ephemeral test identities complete compose -> review ->
  encrypt -> batch -> blob fixture -> reconstruct -> scan -> decrypt -> inbox.
- Refresh restores only bounded, documented local state.
- Corrupt, oversized, duplicate, reordered, and unknown-version fixtures fail
  with explicit evidence states.
- A machine-readable sprint acceptance report points to every proof artifact.
