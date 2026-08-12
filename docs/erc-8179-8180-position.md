# BlobMail position on ERC-8179 and ERC-8180

Status: project design note and prospective standards feedback, 2026-08-11.

BlobMail is an encrypted, recipient-scanned messaging protocol over shared
Ethereum blob data. ERC-8179 (Blob Space Segments) is a natural transport and
discovery dependency. ERC-8180 (Blob Authenticated Messaging, or BAM) is close
prior art with a different default privacy model. BlobMail should inform and
comment on BAM rather than present itself as a competing public-message stack.

Both ERCs are drafts. BlobMail will keep their integration behind explicit
interfaces and will not claim conformance until deployed contract behavior,
test vectors, and indexer behavior have been verified against a stable draft.

## ERC-8179: adopt the segment boundary

BlobMail's 31-byte field-element encoding matches the convention described by
ERC-8179. A maximum V0 batch is 39,472 bytes and needs 1,274 field elements, so
it occupies only about 31 percent of one blob. Declaring a half-open range
`[startFE, endFE)` lets BlobMail share the remaining capacity instead of paying
for or monopolizing a full blob.

The transport now exposes pure, non-publishing segment primitives:

- `segmentPayloadCapacity(startFE, endFE)`;
- `writePayloadToBlobSegment(blob, payload, range)`; and
- `decodePayloadFromBlobSegment(blob, payloadBytes, range)`.

The writer preserves bytes outside the declared range. The decoder interprets
only the declared range, validates its zero field-element prefixes, and rejects
non-zero trailing padding inside that range. This permits another protocol to
use a different encoding outside BlobMail's segment without weakening the
canonical BlobMail representation.

The eventual chain profile should:

1. publish a documented, non-zero content tag such as
   `keccak256("blobmail.v0")`;
2. declare the BlobMail range in the same transaction as its blob;
3. discover batches from `BlobSegmentDeclared` events;
4. treat `contentTag` as a schema filter, never as proof of authorship;
5. detect duplicates and overlaps off chain;
6. roll declarations back on reorgs; and
7. bind settlement evidence to the versioned hash and exact FE coordinates.

The first chain experiment may declare `[0, 4096)` for compatibility. That is
not the target economics and must not be described as shared-segment support.

## ERC-8180: preserve the trust split, challenge the public-message assumption

BAM's most useful contribution is its separation of an untrusted decoder from
a trusted signature verifier. BlobMail already makes a similar distinction in
its evidence model: reconstruction, byte integrity, recipient matching,
authenticated decryption, sender authentication, delivery, and acknowledgement
are different claims.

Direct BAM conformance is not currently appropriate:

- BAM decoders return a public sender address, nonce, and message contents.
- BlobMail content can only be decoded with the intended recipient's HPKE
  private key; that operation cannot be a public on-chain decoder.
- BlobMail V0 intentionally carries no sender identity or signature.
- BAM's signing-key registry authenticates senders, while BlobMail's proposed
  resolver discovers recipient encryption keys. These are different trust and
  privacy functions.
- BAM message exposure is useful for public application reactions but would be
  a privacy failure as the default BlobMail path.

BlobMail can still adopt BAM-shaped ideas:

- registration events may advertise the public envelope codec while leaving
  decryption local;
- optional sender claims and signatures can live inside encrypted plaintext,
  so only the recipient learns and verifies the sender;
- sender signing-key verification must be separate from recipient encryption-
  key resolution;
- atomic multi-segment registration is useful for multiple privacy lanes or a
  blob shared with other protocols; and
- any exposure mechanism must be explicit, minimal, and separate from normal
  private receipt.

## Proposed comment on BAM

BlobMail provides a concrete private-messaging counterexample to an assumption
in the current decoder interface: not every authenticated blob message can or
should yield `(sender, nonce, contents)` to an untrusted public decoder.

A standards comment should ask BAM to clarify one of these boundaries:

1. BAM deliberately standardizes publicly decodable authenticated messaging,
   while encrypted recipient-only protocols compose with ERC-8179 directly; or
2. BAM defines an opaque/encrypted batch profile where the registration event
   discovers an outer codec and verifier policy without requiring public
   plaintext decoding or message exposure.

The first option is smaller and clearer. The second could improve ecosystem
interoperability, but only if it does not turn a decoder address, content tag,
or submitter address into an implied identity or authenticity claim.

## Settlement consequence

ERC-8179 declarations are coordinates, not content proofs. BlobMail's manifest
weakness therefore remains: a manifest leaf may claim bytes that the blob does
not contain. The coordinates nevertheless make the production proof target
precise:

```text
payment authorization
  -> encrypted entry commitment
  -> exact field-element positions
  -> KZG opening(s)
  -> versioned blob hash
  -> batcher payment
```

Per-field-element verification is too expensive for routine full-batch
validation. It remains plausible for individual-entry disputes or as an input
to a later aggregate proof. Event discovery and client-side full-blob KZG
verification should proceed independently of that settlement research.

## Near-term project boundary

This note does not authorize a wallet, signer, funded transaction, contract
deployment, registry write, BAM exposure call, or network publication. The
next implementation work is a segment-aware manifest and read path, followed
by an unsigned ERC-8179/BAM registration-call artifact for human review.
