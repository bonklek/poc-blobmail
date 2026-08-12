# Sepolia sidecar replay

Issue [#6](https://github.com/bonklek/blobmail/issues/6) adds a bounded,
read-only path from an already-included Sepolia type-3 transaction to a
canonical BlobMail batch. It does not construct, sign, or submit a transaction.

## Evidence ladder

The replay advances only in this order:

1. `BLOB_TRANSACTION_INCLUDED`
2. `SIDECARS_MATCHED`
3. `KZG_PROOF_VERIFIED`
4. `BATCH_RECONSTRUCTED`
5. `PAYLOAD_SHA256_VERIFIED`

An error carries only the evidence completed before the failing check. Inclusion
is not finality. Reconstruction is not decryption or delivery. The BlobMail
batch parser runs only after the reconstructed payload digest matches the
manifest.

## Resolution and canonicality

The read path fails closed unless both provider identities match the pinned
Sepolia chain ID and beacon genesis. It then:

- reads the type-3 transaction and checks its versioned hashes byte-for-byte
  against the public manifest;
- reads the execution block both by hash and by number, rejecting a changed
  canonical hash as a reorg;
- derives the beacon slot from the exact execution timestamp;
- resolves the beacon header/root and verifies that its beacon block contains
  the execution block hash;
- records head and finalized checkpoint slots separately;
- tries the current `/eth/v1/beacon/blobs/{root}` endpoint, then the legacy
  `/eth/v1/beacon/blob_sidecars/{root}` endpoint when the current endpoint is
  explicitly unsupported;
- compares inclusion roots and normalized sidecar fingerprints when two beacon
  providers are supplied.

A finalized checkpoint at or after the inclusion slot is recorded as an
observation, not a cryptographic ancestry proof. A non-finalized replay may
still verify KZG and payload bytes, but its receipt remains explicitly
`not_finalized_at_observation`.

## KZG boundary

`kzg-wasm@1.0.0` is pinned by npm integrity, source commit, WASM SHA-256, and
trusted-setup-module SHA-256 in
`reports/sepolia-sidecar-source-provenance.json`. It is a WASM build of
`c-kzg-4844` and verifies every selected blob with
`verifyBlobKZGProof(blob, commitment, proof)`.

The independent check uses the all-zero EIP-4844 blob: both its zero-polynomial
commitment and blob proof are the BLS point-at-infinity encoding. The executable
test checks that fixed expectation before accepting the implementation.

## Bounds

- six wanted blobs maximum;
- two beacon providers maximum;
- twenty total read requests maximum;
- ten-second request timeout;
- 1 MiB execution and 2 MiB beacon response ceilings;
- exact 131,072-byte blobs;
- cache defaults to four entries and eight blob-bytes of capacity;
- cache keys bind chain ID, genesis root, slot, beacon root, and ordered
  versioned hashes.

The cache stores only public sidecar bytes in caller-owned memory. Cache hits
never skip commitment matching or KZG verification.

## Offline reproduction

```sh
pnpm run vectors
node --test test/sepolia-sidecar-replay.test.mjs test/sepolia-sidecar-receipt.test.mjs
pnpm verify
```

The deterministic receipt is
`reports/sepolia-sidecar-fixture-replay.json`. It is labeled
`PASS_FIXTURE` and does not claim a live Sepolia observation.

## Explicit live read

After setting the same public, unauthenticated read-only provider variables
documented in `docs/sepolia-provider-profile.md`, run:

```sh
pnpm probe:sidecars -- --tx 0xPUBLIC_TRANSACTION_HASH --manifest path/to/public-manifest.json
```

The manifest must contain `blobVersionedHashes`, `payloadBytes`, and
`payloadSha256`; `batchId` and `expectedBeaconRoot` are optional additional
bindings. The command writes only a sanitized public receipt to
`reports/sepolia-sidecar-live-replay.json`. It never accepts a private key,
mnemonic, keystore, signer, wallet provider, raw transaction, or submission
endpoint.

The live command becomes useful after the human-only publication ticket #8.
Until then, the deterministic fixture and explicit provider capability probe
are the reproducible evidence.

## Provenance

The acquisition and reconstruction concepts are adapted only from public
`bonklek/eth-radio` commit
`b465e02f88bbca85932344228c1cfe5abfb51253`. Exact source Git blobs, SHA-256
digests, KZG package material, and licenses are recorded in
`reports/sepolia-sidecar-source-provenance.json`. The archived unsafe-history
repository, publisher modules, funded wallet, and signer code were not opened,
copied, or imported.
