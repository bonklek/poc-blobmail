# RFE transport provenance

BlobMail's local, read-only transport kernel adapts the minimum reconstruction
ideas from the public `bonklek/eth-radio` repository. It does not depend on an
ETH Radio package at runtime and it contains no publishing path.

## Pinned public source

- Repository: <https://github.com/bonklek/eth-radio>
- Commit: `b465e02f88bbca85932344228c1cfe5abfb51253`
- Commit date: `2026-07-09T19:09:16-04:00`
- Commit subject: `Redesign decentralized static client`
- Author recorded by Git: `bonklek <142337540+bonklek@users.noreply.github.com>`

The following files were inspected and adapted:

| Public source file | Git blob | SHA-256 | Adapted concept |
| --- | --- | --- | --- |
| `public/decentralized/app.js` | `bdd6c1d38a3e175ffdb2cc088d0138321643a378` | `7d737ed629d4d088210fc6e8157b22c0497ca55690fea9fe60fbfa949dcbe790` | Browser Web Crypto hashing, commitment-derived versioned hashes, bounded sidecar normalization, ordered reconstruction, and verification-state separation |
| `scripts/reconstruct-blob-media.mjs` | `f1fd8e9114a71e7c3d338d6c4a6d1e463e4e96e9` | `8d543a76d6769c878a99b5201ea6eb7bb23aa1559d054a54b390a807845ac5e9` | Zero-prefixed 32-byte field elements carrying 31 data bytes, manifest-order reconstruction, and payload SHA-256 verification |
| `scripts/fetch-blob-sidecars.mjs` | `f1f05f50ae799f806ce68f3ff5f13abdf7bc3466` | `190af2b173d8c5a7ef5dde7d9aa6745e80dc7a5d5f1f9cc9342ee152d09a7a63` | Deriving a versioned hash from each sidecar KZG commitment before selecting wanted sidecars |
| `LICENSE` | `4e66002138dc8dfebffa9f2cb5723c06952a827c` | `6fb5fda028900d05b6a8e9d7775257172e7825dede439edd9052cef2c16a6370` | Viral Public License terms retained verbatim in `THIRD_PARTY_NOTICES.md` |

The checkout used to record these values had origin
`https://github.com/bonklek/eth-radio.git`; the commit and hashes above make the
source inputs independently reproducible even if the default branch moves.

## Local adaptation boundary

`src/transport/blob-codec.js` implements the read format and its inverse for
local fixtures:

- canonical 131,072-byte blobs;
- 4,096 field elements per blob;
- a required zero byte followed by 31 data bytes in every field element;
- a payload capacity of 126,976 bytes per blob;
- an explicit maximum of 16 blobs per local call.

The encoder is the straightforward inverse of the public reconstruction rule.
No ETH Radio publisher, wallet, transaction, key, signer, or bundle code was
copied.

`src/transport/integrity.js` accepts already-supplied sidecars. It performs no
RPC, beacon request, archive request, file write, IndexedDB write, transaction
construction, or broadcast. It:

1. bounds the manifest and candidate sidecar arrays;
2. derives each sidecar's EIP-4844 versioned hash from the 48-byte KZG
   commitment (`0x01 || SHA-256(commitment)[1:]`);
3. rejects a conflicting sidecar-supplied versioned hash, duplicate matches,
   missing matches, inconsistent or non-canonical blob counts, malformed
   sidecar indexes or blobs, and non-zero field-element prefixes;
4. restores manifest order, reconstructs the declared payload length, and
   verifies its SHA-256 digest;
5. emits distinct `SIDECARS_MATCHED`, `BATCH_RECONSTRUCTED`, and
   `PAYLOAD_SHA256_VERIFIED` evidence records only after the corresponding
   check succeeds.

`sidecarCacheKey` is deterministic and storage-agnostic so the browser client
can use its own bounded memory or IndexedDB cache without giving the transport
kernel ambient storage authority.

## Deliberate limits

- `SIDECARS_MATCHED` proves only that a supplied commitment hashes to the
  manifest's versioned hash and that the sidecar bytes passed structural
  validation. This module does **not** verify the KZG proof or prove that the
  supplied blob opens to the commitment; its evidence records therefore set
  `kzgProofVerified: false`.
- `PAYLOAD_SHA256_VERIFIED` is byte-integrity evidence, not delivery, receipt,
  decryption, read, settlement, finality, or sender-authentication evidence.
- Network acquisition and provider/archive provenance remain caller concerns.
  A future read-only acquisition adapter must keep those evidence sources
  distinct.
- The 16-blob call bound is a local resource ceiling, not a statement about a
  particular Ethereum fork's per-block blob target or maximum.
- The repository named `eth-radio-private-unsafe-history` was explicitly
  excluded: it was not cloned, opened, copied, imported, or made a dependency.

## Replay check

Run the transport fixture suite from the BlobMail repository root:

```sh
node --test test/transport-rfe.test.mjs
```

The fixed commitment vector and all payload/sidecar fixtures are local and
synthetic. They contain no RPC response, credential, restricted payload, or
production message.
