# BlobMail

BlobMail is an experimental recipient-private mail client over Ethereum blobs.
The current MVP creates a random X25519 identity in the browser, encrypts the
identity and mailbox with a passphrase, sends 480-byte text messages through a
small Sepolia batcher, and discovers them from ERC-8179-style
`BlobSegmentDeclared` events.

Recipients can be entered as:

- a `blobmail:v0:x25519:...` contact code;
- an Ethereum mainnet `.eth` name; or
- a Gwei Name Service `.gwei` name.

Both name systems use the `com.blobmail` text record. A payment address is
never treated as a messaging key.

This is beta software, not a production mail service. Blob data is temporary,
HPKE base mode does not authenticate a sender, and there are no delivery or
read receipts.

## Run the client

Requirements: Node.js 24+, pnpm 11+, and a modern browser.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm dev
```

Open <http://127.0.0.1:5173>. Create a vault, click **Check chain** once to set
the initial Sepolia cursor, then export the encrypted backup and share the
displayed contact code. The browser stores only the encrypted vault; locking or
reloading requires the passphrase again.

The default RPC endpoints are public, read-only services and can be replaced in
Connection settings. Name resolution uses Ethereum mainnet. Message delivery
uses Sepolia; the default proof-bearing beacon endpoint is ChainSafe Lodestar.

## Run the reference batcher

The batcher is deliberately offline by default:

```sh
pnpm batcher
```

Offline mode accepts, verifies, batches, and KZG-packages ciphertext, but the
client reports `BATCHER_OFFLINE` because no transaction was included. It is a
zero-cost setup check, not delivery.

To publish on Sepolia, fund a dedicated test key and start the isolated Node
operator process:

```sh
BLOBMAIL_BATCHER_MODE=sepolia \
BLOBMAIL_BATCHER_SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
BLOBMAIL_BATCHER_PRIVATE_KEY=0x... \
BLOBMAIL_BATCHER_ALLOWED_ORIGIN=http://127.0.0.1:5173 \
pnpm batcher
```

On PowerShell, set the same variables with `$env:NAME='value'`. The key is read
only by the Node batcher, never by browser code. Startup verifies Sepolia chain
ID and the pinned BAM/BSS runtime bytecode, while fee caps bound each
transaction. See [MVP testing](./docs/mvp-testing.md) for the two-profile test
and failure diagnostics.

## Protocol path

```text
name/contact code
  -> X25519 public key
  -> local HPKE encryption
  -> bounded ciphertext-only batcher
  -> one EIP-4844 blob + declareBlobSegment(..., blobmail.v0)
  -> bounded event discovery
  -> execution/beacon canonicality + KZG verification
  -> field-element segment reconstruction
  -> recipient-local scan and decryption
  -> passphrase-encrypted inbox
```

The declaration contract is the Sepolia BAM core/BSS deployment at
`0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314`. BlobMail uses its inherited
segment declaration surface as an ERC-8179 discovery boundary; it does not
claim that recipient-private ciphertext is a publicly decodable BAM message.

## Security boundaries

- Private messaging keys, plaintext, and RPC/batcher settings never enter the
  blob declaration.
- The browser does not hold a funded Ethereum key or submit transactions.
- The batcher receives a fixed-size authenticated ciphertext entry only.
- A send is shown as successful only after a matching included transaction.
- Receiving advances its cursor only after every declaration in the bounded
  scan verifies; the stored block hash detects reorgs on the next refresh.
- Blob commitment-derived versioned hashes and KZG proofs are verified before
  batch parsing or decryption.
- Decrypted text is inserted with `textContent`, not interpreted as HTML.

Run the complete deterministic and adversarial gate with:

```sh
pnpm verify
```

The checked-in live receipt can also be reverified from public Sepolia data
(no wallet or private key required):

```sh
pnpm verify:live
```

## Documentation

- [MVP setup and two-user test](./docs/mvp-testing.md)
- [Identity, `.eth`, and `.gwei` profile](./docs/identity-resolution.md)
- [Core protocol V0](./docs/core-protocol-v0.md)
- [ERC-8179 / ERC-8180 position](./docs/erc-8179-8180-position.md)
- [Sepolia sidecar replay](./docs/sepolia-sidecar-replay.md)
- [Live Sepolia MVP receipt](./reports/sepolia-mvp-live-acceptance.json)
- [Architecture](./docs/master-architecture.md)

## Status

The standalone Sepolia MVP is under active beta validation. Rich media,
attachments, sender authentication, anonymous sponsorship, production
settlement, background notifications, and public BAM exposure are deferred.
