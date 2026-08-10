# BlobMail closed core protocol V0

Status: normative Sprint 0 fixture profile. Protocol version `0` is intentionally
closed: implementations must reject unknown versions, suite identifiers, content
kinds, flags, reserved bytes, sizes, and ordering instead of guessing how to
interpret them.

This profile proves a local, text-only encrypted loop. It does not define a
network, transaction, wallet, registry, acknowledgement, settlement, or
production anonymity protocol.

## Cryptographic profile

BlobMail V0 uses RFC 9180 base mode with this one suite:

| Component | Identifier |
| --- | ---: |
| DHKEM(X25519, HKDF-SHA256) | `0x0020` |
| HKDF-SHA256 | `0x0001` |
| AES-128-GCM | `0x0001` |

The HPKE `info` byte string is the UTF-8/ASCII encoding of
`BlobMail/v0/hpke-info` followed by one NUL byte. The sender is anonymous at the
HPKE layer; V0 carries no sender identity or signature.

The 16-byte recipient tag is the first 16 bytes returned by the RFC 9180 HPKE
exporter with exporter context `BlobMail/v0/recipient-tag` followed by one NUL
byte. It is not a hash of a public recipient key. A scanner creates a recipient
context for each entry and compares the exported tag before AEAD open. A tag
mismatch is `NOT_RECIPIENT`; a matching tag followed by failed AEAD
authentication is `HPKE_OPEN_FAILED`. A random false-positive tag therefore
does not yield plaintext. Its probability is at most 2^-128 before considering
an adversarially constructed entry.

This tag removes the trivial public-key enumeration that a public
`hash(public_key, enc)` hint would allow. It does not hide blob access patterns,
batch timing, entry count, fixed size, or the recipient's own scan traffic.

## Domain separation

Every ASCII value below includes its final NUL byte. Concatenation is direct
because the fixed domain string is a unique prefix and all following wire fields
have fixed or framed lengths.

| Use | Domain/context bytes |
| --- | --- |
| Identity ID | `BlobMail/v0/identity\0` |
| Recipient HPKE exporter | `BlobMail/v0/recipient-tag\0` |
| HPKE AAD prefix | `BlobMail/v0/aad\0` |
| Entry commitment | `BlobMail/v0/entry-commitment\0` |
| Batch commitment | `BlobMail/v0/batch-commitment\0` |

An identity ID is lowercase hexadecimal
`SHA-256(identity-domain || 32-byte-public-key)`. Entry and batch IDs are the
lowercase hexadecimal commitments defined below. These SHA-256 values are
integrity identifiers, not hiding commitments.

## Canonical text plaintext

The decrypted plaintext is exactly 512 bytes:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII `BMP0` |
| 4 | 1 | version `0` |
| 5 | 1 | content kind `1` (UTF-8 text) |
| 6 | 2 | UTF-8 byte length, unsigned big-endian |
| 8 | 480 | message area |
| 488 | 24 | reserved padding |

The length is from 1 through 480. The message begins at offset 8; every byte
after the declared message is zero, including unused message-area bytes and the
reserved tail. Text is valid UTF-8 in Unicode NFC form. The encoder normalizes
input to NFC; the decoder rejects non-NFC bytes. Decoded bytes remain untrusted
text and must not be interpreted as markup.

## Canonical encrypted entry

An entry is exactly 616 bytes:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII `BME0` |
| 4 | 1 | version `0` |
| 5 | 1 | suite ID `1` (the suite above) |
| 6 | 2 | flags, zero |
| 8 | 16 | secret HPKE-exported recipient tag |
| 24 | 32 | HPKE encapsulated key `enc` |
| 56 | 528 | HPKE ciphertext: 512 bytes plus 16-byte GCM tag |
| 584 | 32 | entry commitment |

HPKE additional authenticated data is
`BlobMail/v0/aad\0 || entry[0..56]`. The commitment is
`SHA-256(BlobMail/v0/entry-commitment\0 || entry[0..584])`. The commitment is
verified before recipient scanning or decryption.

## Canonical batch

A batch contains 1 through 64 entries and is exactly `48 + 616 * count` bytes:

| Offset | Size | Field |
| ---: | ---: | --- |
| 0 | 4 | ASCII `BMB0` |
| 4 | 1 | version `0` |
| 5 | 1 | flags, zero |
| 6 | 2 | entry size `616`, unsigned big-endian |
| 8 | 2 | entry count, unsigned big-endian |
| 10 | 2 | reserved, zero |
| 12 | 4 | body length `616 * count`, unsigned big-endian |
| 16 | variable | entries |
| final 32 | 32 | batch commitment |

Entries are strictly ascending by their 32-byte commitment, compared
lexicographically as unsigned bytes. `packBatch` sorts a copy. Parsing rejects
duplicates and reordering. The final value is
`SHA-256(BlobMail/v0/batch-commitment\0 || header || entries)`.

Deduplication across already separated entries retains the first verified byte
copy and reports later equal entry IDs as duplicates. Duplicate entries within a
canonical batch are invalid.

## API and evidence boundary

`src/protocol/index.js` exports browser/Node byte APIs:

- `deriveIdentity`, `importIdentity`, and `identityId`;
- `encodePaddedText` and `decodePaddedText`;
- `encryptText`, `parseEntry`, `verifyEntry`, and `decryptEntry`;
- `packBatch`, `parseBatch`, `scanBatch`, and `deduplicateEntries`.

Cryptographic and hashing operations are asynchronous because they use Web
Crypto and the pinned HPKE implementation. Passing a 32-byte seed to
`deriveIdentity` or `ephemeralSeed` to `encryptText` is only for deterministic
fixtures. Production use must omit those values so Web Crypto supplies fresh
randomness.

`vectors/blobmail-v0.json` contains deliberately public fixture key material.
`test/independent-vectors.test.mjs` reconstructs the framing and SHA-256
digests with Node's crypto implementation without calling the primary encoder.
`reports/crypto-encoding-probe.json` records the exact dependency versions,
observed identifiers, round trip, and corruption result.

Evidence states remain distinct: reconstructing a containing blob does not
prove entry integrity; entry commitment verification does not prove recipient
membership; recipient-tag match does not prove authenticated decryption; and
decryption does not prove reading, acknowledgement, publication, or settlement.
