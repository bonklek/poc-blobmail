# Test the standalone Sepolia MVP

This guide tests two independent browser profiles against one local reference
batcher. Use dedicated Sepolia funds only. Never reuse a mainnet-funded key.

## 1. Verify a clean checkout

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` regenerates deterministic vectors and reports, runs protocol,
resolver, vault, sender, receiver, HTTP, KZG, reorg, and DOM tests, performs the
source safety audit, and builds the browser clients.

## 2. Start the browser client

```sh
pnpm dev
```

Open <http://127.0.0.1:5173> in two separate browser profiles. In each:

1. create a different passphrase-protected vault;
2. click **Check chain** once;
3. confirm the UI says the mailbox was initialized at a Sepolia block;
4. copy the encrypted backup somewhere safe for the test;
5. copy the contact code.

Initialization deliberately starts near the current chain head. Do it before
sharing the contact code so the first message cannot fall before the cursor.

## 3. Check the batcher without spending funds

```sh
pnpm batcher
```

The server listens on `127.0.0.1:8787` and accepts the Vite origin only. Send a
message from profile A to profile B's contact code. The expected result is
`BATCHER_OFFLINE`: encryption, intake, canonical batching, and KZG packaging
succeeded, but no inclusion is claimed.

## 4. Enable Sepolia publication

Set these in the batcher process environment:

```text
BLOBMAIL_BATCHER_MODE=sepolia
BLOBMAIL_BATCHER_HOST=127.0.0.1
BLOBMAIL_BATCHER_PORT=8787
BLOBMAIL_BATCHER_ALLOWED_ORIGIN=http://127.0.0.1:5173
BLOBMAIL_BATCHER_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
BLOBMAIL_BATCHER_PRIVATE_KEY=0x<dedicated funded 32-byte key>
```

Optional fee controls are documented in `.env.example`. Defaults cap total
exposure at 0.005 Sepolia ETH and the implementation has an additional hard
0.01 test-ETH ceiling. Startup fails if the chain or pinned declaration
contract bytecode does not match.

Restart `pnpm batcher`, then send from A to B. A must show an included
transaction hash. In B, click **Check chain** after two execution blocks. The
message must appear only after execution/beacon provenance, commitment-derived
versioned hash, KZG proof, segment padding, batch commitment, entry commitment,
recipient tag, HPKE authentication, and UTF-8 validation all pass.

Lock and unlock both profiles. Sent and Inbox messages must survive. A third
identity must not decrypt B's entry.

## 5. Test `.eth` and `.gwei`

Publish this text record on a name you control:

```text
key: com.blobmail
value: <recipient profile's complete blobmail:v0 contact code>
```

The client can prepare unsigned transaction fields under **Prepare a .eth or
.gwei text-record transaction**. Review and submit them in the name owner's
wallet, then wait for confirmation. Send again using the name instead of the
raw code. Resolution must show an error for empty, malformed, wrong-chain, or
unsupported records; it never falls back to the name's payment address.

The MVP reads direct onchain ENS text resolvers. Names whose resolution requires
CCIP Read are rejected until a bounded gateway policy is implemented.

## Failure diagnostics

- `BATCHER_OFFLINE`: operator process is packaging only; enable explicit
  Sepolia mode.
- `CHAIN_ID_MISMATCH`: an RPC endpoint is on the wrong network.
- `REORG_DETECTED` / `REORGED_BLOCK`: refresh did not advance; retry after the
  chain stabilizes.
- `INVALID_KZG_PROOF`: sidecar bytes/proof are untrusted; nothing is decrypted.
- `MISSING_SIDECAR`: the selected beacon endpoint has no matching retained blob.
- `BLOBMAIL_RECORD_NOT_FOUND`: the name has no `com.blobmail` record.
- `INVALID_BLOBMAIL_RECORD`: the name record is present but its contact code is
  malformed or checksum-invalid.
- `PUBLICATION_TIMEOUT`: no included state arrived within the bounded poll.

Do not paste private keys into the browser settings, issue reports, logs, or
repository files. The only supported funded-key boundary is the batcher process
environment or an operator-managed secret store.

The repository's finalized acceptance transaction can be independently replayed
without a wallet or private key:

```sh
pnpm verify:live
```

This command rechecks canonical execution inclusion, the beacon root, KZG proof,
declared field-element range, batch digest, intended-recipient decryption, and
wrong-recipient rejection against the public receipt.

The default browser beacon provider is ChainSafe Lodestar. During the live MVP
acceptance, PublicNode's blobs-only endpoint returned matching blob bytes and a
matching commitment but its legacy endpoint returned a proof that failed KZG;
the receiver correctly stopped. Do not override the default with that endpoint
until its proof-bearing response is independently verified.
