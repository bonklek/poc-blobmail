# BlobMail

BlobMail now includes a runnable, local-only proof of its core mail loop. The
first-pass browser client composes a bounded text message, encrypts it for a
deterministic test recipient, packs the entry into an Ethereum-blob-shaped
memory fixture, reconstructs and verifies it, decrypts it, and stores a bounded
local mailbox with separate Inbox and Sent views.

It does **not** broadcast, construct transactions, connect a wallet, submit a
bundle, prove KZG, or claim chain inclusion. It remains an experimental
protocol and architecture workspace, not a production messaging system.

## Run the first client

Requirements: Node.js 24 or newer and pnpm 11.

```sh
pnpm install --frozen-lockfile
pnpm verify
pnpm dev
```

Open <http://127.0.0.1:5173>, choose the local Alice fixture profile, compose a
message, review the exact UTF-8 byte length, and send it to Bob. Alice's Sent
view retains the reconstructed local copy. Switch to the Bob fixture profile to
see the same message in Bob's Inbox with its staged evidence. A second terminal
can verify the running server:

```sh
pnpm probe:client
```

`pnpm verify` regenerates the deterministic golden vector, runs the full test
suite, performs the no-broadcast safety scan, builds both the standalone client
and fixture-only milXdy package, runs the offline package verifier, and
regenerates machine-readable acceptance reports.

## Read-only Sepolia replay

The testnet layer includes an explicit, offline-by-default Sepolia provider
profile and a bounded sidecar replay path for already-published type-3
transactions. The replay binds execution block and beacon-root provenance,
matches commitment-derived versioned hashes, verifies every KZG proof, restores
the declared payload, checks SHA-256, and only then parses the BlobMail batch.
See [the Sepolia sidecar guide](./docs/sepolia-sidecar-replay.md).

This path still has no wallet, signer, transaction construction, or submission
surface. The one funded testnet publication remains a separate human-only
operator action.

## Optional read-only Sepolia probe

The application remains offline by default. An explicit Node-only provider
probe can validate Sepolia execution and Beacon identities and bounded read
capabilities without loading a wallet or constructing a transaction. See the
[Sepolia provider profile](./docs/sepolia-provider-profile.md) for environment
setup, fixed limits, live receipt, public eth-radio provenance, and the
human-only funded-wallet boundary.

## What runs

- HPKE base mode: X25519/HKDF-SHA-256 with AES-128-GCM
- Canonical 512-byte padded plaintext and 616-byte encrypted entry
- Recipient-private 16-byte HPKE exporter tag
- Canonically sorted, bounded batches
- 31-byte payload packing into EIP-4844-shaped field elements
- Digest-checked reconstruction, recipient scan, and strict UTF-8 decryption
- Bounded browser storage: 12 messages and 32 KiB serialized state
- Signed-out startup with an explicit local fixture-profile chooser
- Separate per-profile Inbox and Sent views over the bounded local message store

The local Alice/Bob identities and deterministic test vectors exist only for
replayable fixtures. HPKE base mode does not authenticate the selected sender.
The UI therefore records `selectedSenderIdentityId`, not a provenance claim.
The profile chooser is not account authentication: it has no password, wallet,
remote session, recovery flow, or persisted signed-in state.

## Evidence and integration

- [Sprint agent prompt](./docs/SPRINT_0_AGENT_PROMPT.md)
- [Normative protocol profile](./docs/core-protocol-v0.md)
- [Public eth-radio provenance](./docs/rfe-transport-provenance.md)
- [Read-only Sepolia provider profile](./docs/sepolia-provider-profile.md)
- [milXdy adapter boundary](./docs/milxdy-adapter-boundary.md)
- [Golden vector](./vectors/blobmail-v0.json)
- [Sprint acceptance report](./reports/sprint-0-acceptance.json)

The public `bonklek/eth-radio` transport concepts are adapted at the exact
commit and file hashes recorded in the provenance document. No private or
unsafe-history repository was used.

## Why this exists

BlobMail is trying to answer a specific design question:

> Can a browser-extension messaging app use Ethereum blobs as a shared encrypted mail availability layer, while preserving useful recipient privacy, optional sender privacy, and permissionless batching economics?

The current design assumes:

- recipient-hiding encryption is always on;
- users publish or resolve messaging public keys through a registry;
- payloads are padded into common public size classes;
- text, images, GIFs, audio, video, files, mixed multipart content, and arbitrary application bytes can use the same encrypted payload envelope;
- large payloads are encrypted, chunked, and optionally dispersed;
- pending messages can propagate through an AA/Paraclete-style mempool;
- ERC-4337 bundlers can be extended into blob-aware batchers;
- settlement starts on testnet with a weaker manifest-based proof, then moves toward production-grade blob-content linkage.

## Start here

- [Request for comments](./REQUEST_FOR_COMMENTS.md)
- [Master architecture](./docs/master-architecture.md)
- [Privacy technology options](./docs/privacy-tech.md)
- [Posting client](./docs/posting-client.md)
- [Receiving client](./docs/receiving-client.md)
- [AA mempool and Paraclete layer](./docs/aa-mempool-paraclete.md)
- [Blob batching and settlement](./docs/blob-batching-settlement.md)
- [RemiNet OAuth and identity](./docs/reminet-oauth-identity.md)
- [Frontend privacy/cost modes](./docs/frontend-modes.md)
- [Open questions](./docs/open-questions.md)

## Feedback requested

Feedback is especially useful on:

- public-key registry design;
- `.gwei` / on-chain identity-key mapping;
- committed or salted registry migration paths;
- ERC-4337 UserOperation compatibility;
- Paraclete integration;
- paymaster and anonymous sponsorship design;
- blob batch construction;
- inclusion proof and settlement design;
- receiver-side blob scanning;
- IP privacy defaults for browser gossip.

## Status

Sprint 0 local loopback implementation. RFC topics involving registries,
ERC-4337, paymasters, Paraclete, settlement, verified sidecar reconstruction,
and production privacy remain future work and are intentionally absent here.
The optional Node-only Sepolia command probes bounded read capabilities; it is
not wired into the application or transport runtime.
