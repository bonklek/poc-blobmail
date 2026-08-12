# Request for comments: BlobMail

BlobMail is a proposed private encrypted messaging system using shared Ethereum blob batches as the delivery/availability layer.

BlobMail now treats ERC-8179 Blob Space Segments as its intended allocation and
discovery boundary. ERC-8180 Blob Authenticated Messaging is the closest
standards proposal, but its public decoder interface is not directly suitable
for recipient-only encrypted contents. BlobMail is therefore also a concrete
privacy-oriented comment on BAM: can the standard clearly distinguish public
authenticated messages from opaque or recipient-private authenticated
payloads without making public exposure a protocol requirement?

The motivating product is a browser-extension mail/chat surface for X/Twitter users. Alice selects Bob's X profile, resolves Bob's messaging public key, encrypts locally, submits a padded encrypted payload into a shared pending layer, and a blob-aware bundler batches many such payloads into one Ethereum blob. Bob's client scans blob batches and decrypts entries intended for him.

## What is being proposed

The architecture combines:

- recipient-key encryption, likely HPKE;
- crypto-agile larger lanes that can potentially hide HPKE versus hybrid post-quantum encryption inside a fixed envelope;
- public or semi-public identity-to-messaging-key registry;
- optional `.gwei` naming;
- padded payload size classes;
- arbitrary private content types such as text, images, GIFs, audio, video, attachments, mixed multipart content, or application-specific binary objects;
- encrypted chunking for large payloads;
- optional sender-side decryptability for sent-message audit/history;
- ERC-4337 UserOperations for payment/authorization;
- paymasters for sponsorship;
- optional Semaphore-style anonymous sponsorship;
- Paraclete-style browser gossip for pending operations;
- blob-aware bundlers/batchers;
- testnet-first settlement.

## Main architectural bet

The system should avoid a central message queue without pretending Ethereum contracts can batch messages by themselves.

The likely shape is:

```text
browser extension
  -> AA / Paraclete-style pending layer
  -> blob-aware bundler
  -> Ethereum blob transaction
  -> receiver scans and decrypts
```

## Specific feedback requested

### Registry

For v1, public membership is acceptable.

Current leading option:

```text
identity_hash -> messaging_public_key
```

Questions:

- Should the first registry be a simple public on-chain mapping?
- Should identity hash use X account ID, normalized handle, `.gwei`, or another identifier?
- How should the design preserve a path to salted commitments later?
- Is there existing registry work this should reuse?

### AA / Paraclete

Questions:

- Should encrypted payloads be embedded directly in UserOperations?
- Or should UserOperations carry commitments while encrypted payloads move as adjacent gossip objects?
- Would Paraclete support a BlobMail-specific topic/object type?
- What constraints would current ERC-4337 bundlers impose?

### Batching and settlement

The v1 testnet settlement path may use a manifest-based proof:

```text
entry_hash -> manifest_root -> batcher payment
```

Known weakness:

This proves inclusion in the manifest, not necessarily that the actual blob bytes at the claimed position contain the entry.

Production target:

```text
payment authorization
  -> entry_hash
  -> exact blob position or polynomial opening
  -> blob commitment / versioned blob hash
  -> batcher payment
```

Questions:

- What is the cheapest practical proof path for tying an entry to actual blob data?
- Can this be made compatible with ERC-4337 paymaster settlement?
- Should v1 include a challenge window, or only use client-side auditing while the proof model is hardened?

### Rich content

BlobMail entries should be treated as encrypted byte payloads, not just plaintext messages.

Questions:

- What private metadata should every payload carry: MIME type, filename, codec, dimensions, duration, content hash, compression mode, or preview policy?
- Should the encrypted content container use MIME-like multipart semantics, CBOR/JSON manifest semantics, a zip-like bundle, or something else?
- Should media previews be generated only after decryption?
- How should large private video/audio messages be chunked, dispersed, and reassembled?
- Should content-type metadata always be encrypted, even if the public size class leaks rough volume?
- How should the receiving client avoid accidentally opening or executing malware after decryption?

### Crypto agility

Standard HPKE is not post-quantum secure. One proposed compromise is:

```text
small lanes:
  HPKE only
  cheap small messages

larger lanes:
  fixed envelope large enough for hybrid/PQ key material
  HPKE and hybrid/PQ entries padded to look the same within the lane
```

Questions:

- Is this a reasonable way to preserve cheap small messages while supporting long-term confidentiality modes?
- Which size classes should be PQ-capable?
- What hybrid KEM construction should be considered first?
- How should the UI explain that the larger security lane is more expensive and only hidden within that lane?

### Privacy defaults

Questions:

- Should private mode require relay-only networking by default?
- How should browser peers avoid direct IP exposure?
- Is two-hop relay practical in a browser extension context?
- How should sender privacy be presented without overclaiming anonymity?

## Current docs

- [Master architecture](./docs/master-architecture.md)
- [Privacy technology options](./docs/privacy-tech.md)
- [Posting client](./docs/posting-client.md)
- [Receiving client](./docs/receiving-client.md)
- [AA mempool and Paraclete layer](./docs/aa-mempool-paraclete.md)
- [Blob batching and settlement](./docs/blob-batching-settlement.md)
- [RemiNet OAuth and identity](./docs/reminet-oauth-identity.md)
- [Frontend privacy/cost modes](./docs/frontend-modes.md)
- [Open questions](./docs/open-questions.md)
