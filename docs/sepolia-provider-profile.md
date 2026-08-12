# Read-only Sepolia provider profile

GitHub issue [#5](https://github.com/bonklek/blobmail/issues/5) adds the
smallest live-network boundary needed before BlobMail can test blob retrieval.
It does not add a wallet, signer, transaction builder, transaction submission,
or funded-key access. The browser application remains offline.

## Activation and fail-closed identity

`createNetworkProfile()` defaults to `offline`. A live probe requires all of
the following environment values and the explicit mode `readonly`:

```text
BLOBMAIL_NETWORK_MODE=readonly
BLOBMAIL_NETWORK=sepolia
BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
BLOBMAIL_SEPOLIA_BEACON_RPC_URL=https://lodestar-sepolia.chainsafe.io
BLOBMAIL_SEPOLIA_ALLOWED_HOSTS=ethereum-sepolia-rpc.publicnode.com,lodestar-sepolia.chainsafe.io
```

The checked-in [`.env.example`](../.env.example) stays offline. The probe does
not load a `.env` file, so opting in requires setting the process environment
for that one command. Provider URLs must be HTTPS roots with default port 443,
no authority credentials, no path, no query, and no fragment. Every hostname
must also appear in the bounded operator allowlist. Execution and Beacon roles
must use different hostnames. Single-label names, IP literals, and `.local` or
`.internal` hosts are rejected even if supplied in that allowlist.

Before any capability work, the probe concurrently performs exactly two
identity requests:

| Role | Request | Required Sepolia identity |
| --- | --- | --- |
| Execution | `eth_chainId` | `11155111` (`0xaa36a7`) |
| Beacon | `GET /eth/v1/beacon/genesis` | time `1655733600`, fork `0x90000069`, validators root `0xd8ea171f…9b8078` |

An unknown configured network, wrong execution chain, wrong Beacon genesis, or
failed identity request stops all subsequent capability calls. The pinned
Beacon identity matches the public `eth-clients/sepolia` network
configuration.

## Bounded capability matrix

The complete successful run makes nine requests with at most two in flight:

| Provider | Read-only checks |
| --- | --- |
| Execution | `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber("latest", true)`, and a null-sentinel `eth_getTransactionByHash` |
| Beacon | genesis, head header, finalized header, legacy `blob_sidecars/head?indices=0`, and current `blobs/head` with an impossible versioned-hash sentinel |

The execution probe reads a bounded full latest block, records the transaction
count and the number of type-3/blob transactions without retaining any
transaction bytes, hashes, addresses, or calldata. It also records whether the block exposes
`blobGasUsed`, `excessBlobGas`, and `parentBeaconBlockRoot`. The null
transaction hash exercises transaction lookup without naming a user or real
transaction. The Beacon sentinels bound blob response size while recording
whether each endpoint is available, empty, rejects the sentinel, is
unsupported, or returns a provider error. The legacy sidecar result and the
current blobs result remain separate because the former is deprecated after
Fulu but still matters to the existing eth-radio-derived transport.

Hard limits are:

- 8 second timeout per request;
- 1 MiB execution and 384 KiB Beacon response ceilings;
- 4 KiB request-body ceiling in the Node adapter;
- nine requests total and concurrency of two;
- `GET` or `POST` only, no redirect following, compressed responses disabled;
- four allowlisted JSON-RPC reads and fixed Beacon paths.

These are capability observations, not KZG verification or chain-inclusion
proofs. Ticket #6 owns sidecar normalization, KZG proof validation, retention,
and reorg behavior.

## Run and verify

PowerShell:

```powershell
$env:BLOBMAIL_NETWORK_MODE='readonly'
$env:BLOBMAIL_NETWORK='sepolia'
$env:BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL='https://ethereum-sepolia-rpc.publicnode.com'
$env:BLOBMAIL_SEPOLIA_BEACON_RPC_URL='https://lodestar-sepolia.chainsafe.io'
$env:BLOBMAIL_SEPOLIA_ALLOWED_HOSTS='ethereum-sepolia-rpc.publicnode.com,lodestar-sepolia.chainsafe.io'
pnpm probe:sepolia
```

The command overwrites only
[`reports/sepolia-provider-probe.json`](../reports/sepolia-provider-probe.json).
That receipt contains provider IDs and allowlisted public hostnames, public
chain observations, runtime versions, the replay command, fixed bounds, stable
diagnostic codes, exact public-source provenance, and SHA-256 digests for the
observation and implementation evidence. It does not
persist URLs, query strings, response bodies, headers, environment values, or
exception messages. Execution and Beacon results remain independently
inspectable even when one fails.

Offline fixture coverage:

```sh
node --test test/network-profile.test.mjs test/network-probe.test.mjs
pnpm audit:safety
```

Optional live integration is deliberately separate from `pnpm verify`, so the
workspace remains reproducible without internet access.

## Public-source provenance and reuse boundary

The profile adapts only read-side concepts from public
[`bonklek/eth-radio`](https://github.com/bonklek/eth-radio) commit
`b465e02f88bbca85932344228c1cfe5abfb51253`:

| Upstream file | Git blob | Concept adapted |
| --- | --- | --- |
| `scripts/chains.mjs` | `84e71ec62f6dcdae85c0e47fb670a025f8778689` | explicit supported-chain selection and RPC chain mismatch rejection |
| `.env.example` | `4dc161ce326f6a25b8aec15f087eb3daf47bdfc3` | separate execution and Beacon endpoint configuration; Sepolia-first operator ergonomics |
| `scripts/check-wallet.mjs` | `6d1716e2cea4de51f78850112065e3249ce7556a` | concurrent read-only chain/head observations only |

The last source also derives an account and reads a balance. Neither behavior,
its signer import, nor its key environment variable was copied. No code or
evidence was taken from the archived unsafe-history repository. The pinned
source default `sepolia.drpc.org` remains an allowed public endpoint, but the
checked-in 2026-08-10 receipt uses PublicNode's execution endpoint because it
completed the bounded live probe.

Network constants are corroborated by the public
[`eth-clients/sepolia`](https://github.com/eth-clients/sepolia) configuration.
Beacon endpoint names follow the
[`ethereum/beacon-APIs`](https://github.com/ethereum/beacon-APIs) specification;
both old and new blob retrieval shapes are probed because Sepolia has activated
Fulu.

## Funded-wallet boundary

The funded Sepolia wallet mentioned in the testnet epic remains exclusively in
the operator-controlled public eth-radio checkout. This ticket never locates,
loads, copies, prints, or tests that key. Human-only ticket #8 may later publish
an already-reviewed unsigned artifact; only its public address and public
transaction evidence may cross back into BlobMail.
