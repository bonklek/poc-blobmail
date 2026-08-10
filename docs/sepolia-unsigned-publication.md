# Unsigned Sepolia publication package

Ticket #7 stops at a deterministic, review-only EIP-4844 package. It does not
connect a wallet, read a key, create a signature, serialize a signed
transaction, or submit anything.

## Generate the fixture

```sh
pnpm run package:sepolia:unsigned
```

The command selects only the public identities and canonical encrypted batch
from `vectors/blobmail-v0.json`. It never copies that vector's public test
private material into the publication package. Explicit chain, publisher,
reference-block, fee, cap, review, and expiry values come from
`vectors/sepolia-publication-input-v1.json`.

The committed input uses `0x1111111111111111111111111111111111111111` as an
obvious fixture publisher. Before the human-only ticket #8, the operator may
replace only that public address and the public fee/reference fields, then
regenerate and review the package. Never place a private key, mnemonic,
keystore, authenticated RPC URL, signer, wallet object, or signature in the
input.

## Output

`artifacts/sepolia-unsigned-publication-v1/` contains:

- `batch.bin` — the already-encrypted canonical BlobMail batch;
- `blob-0.bin` — exactly one canonical 131,072-byte blob;
- `blob-sidecar.json` — commitment, proof, versioned hash, and digests;
- `unsigned-request.json` — a review description of the type-3 transaction;
- `manifest.json` — inputs, caps, cost math, expiry, fixture identities, and
  pinned public ETH Radio provenance.

`unsigned-request.json` is data, not a JSON-RPC call. It contains no method,
endpoint, signature fields, raw transaction, or submission instructions. The
destination is the expected publisher itself, value is zero, and calldata is
empty.

The machine-readable receipt is
`reports/sepolia-unsigned-publication.json`. It binds every generated file and
the generator inputs/source with SHA-256.

## Fee and expiry boundary

All amounts are canonical decimal integer strings and all arithmetic uses
`BigInt`:

```text
execution upper bound = gas limit × max fee per gas
blob upper bound      = 131072 × max fee per blob gas
total upper bound     = execution upper bound + blob upper bound
```

Each component must fit its explicit cap, the total must fit the explicit
exposure cap, and the total cap cannot exceed the hard fixture ceiling of
0.01 test ETH. The observed execution and blob base fees must fit their
per-gas caps. The reference must be no more than 600 seconds old, may remain
valid for at most 1,800 seconds and 150 blocks, and is valid at its exact time
or block boundary but not one unit past it. The review block hash must equal
a canonical reread of the reference block hash.

The committed reference is deterministic fixture evidence, not a live fee
quote and not authorization to spend.

## Independent checks

```sh
node --test test/publication-cost.test.mjs \
  test/publication-package.test.mjs \
  test/sepolia-unsigned-publication-receipt.test.mjs
pnpm audit:safety
pnpm verify
```

Tests independently reconstruct the batch from the blob, recompute and verify
KZG material, bind every file digest, exercise cap/expiry boundaries, mutate
blob/commitment/proof bytes, reject wrong-chain and reorged inputs, reject
secret-shaped or unknown fields, and prove the publication module has no
network, environment, wallet, signing, serialization, or submission import.

## Human-only handoff

Ticket #8 remains blocked and human-operated. The owner of the existing
ETH Radio Sepolia wallet reviews this package in their trusted ETH Radio
checkout and may construct, sign, and publish there. The wallet and its
credentials remain in that checkout. BlobMail records only the public address,
transaction hash, block/slot provenance, versioned hash, cost, and payload
digests returned by the operator.
