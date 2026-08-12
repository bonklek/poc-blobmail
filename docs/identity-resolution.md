# BlobMail identity and name resolution profile

Status: MVP implementation profile, 2026-08-12.

BlobMail accepts three recipient forms:

1. a raw checksummed BlobMail contact code;
2. an ENS `.eth` name with a BlobMail text record; or
3. a Gwei Name Service `.gwei` name with the same BlobMail text record.

Name resolution discovers a messaging encryption key. It never treats the
Ethereum payment address of a name as a BlobMail key.

## Contact code

The closed V0 contact-code form is:

```text
blobmail:v0:x25519:<unpadded-base64url-32-byte-public-key>:<16-lowercase-hex-checksum>
```

The checksum is the first eight bytes of:

```text
SHA-256("BlobMail/v0/contact-code\0" || public_key)
```

It detects transcription and record corruption. It is not a signature or an
identity proof. The existing BlobMail identity ID remains:

```text
SHA-256("BlobMail/v0/identity\0" || public_key)
```

## Name record

Both namespaces store the complete contact code in this text record:

```text
key:   com.blobmail
value: blobmail:v0:x25519:...
```

The record value contains the version, so future key formats can retain the
stable lookup key while failing closed in clients that do not understand the
new version.

## `.eth`

The client applies ENSIP-15 normalization, computes the EIP-137 namehash,
reads the resolver from the ENS Registry, and calls the resolver's standard
`text(bytes32,string)` method at one pinned block number. The registry address
is:

```text
0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
```

An absent resolver, empty record, ABI failure, invalid contact code, wrong
chain, or provider failure is a hard resolution failure. The MVP direct reader
does not silently follow an arbitrary HTTP endpoint returned through CCIP Read;
bounded CCIP Read support requires a separate gateway policy and test profile.

ENS resolution and Sepolia message delivery are separate network decisions.
Production `.eth` records normally live on Ethereum mainnet even while the
message itself is delivered through Sepolia during beta testing.

## `.gwei`

GNS exposes ENS-compatible text records directly from `NameNFT`. The verified,
non-upgradeable deployment is at the same address on Ethereum mainnet and
Sepolia:

```text
0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6
```

The client applies ENSIP-15 normalization, computes the namehash, and calls
`text(bytes32,string)` at a pinned block. GNS returns an empty record for an
inactive name, so expired and invalidated names fail closed without falling
back to their owner or payment address.

Mainnet is the canonical namespace. Sepolia GNS resolution is supported as an
explicit beta/testing source and must be identified as such in UI evidence.

## Updating a record

The identity module can build, but never sign or submit, the corresponding
transaction request:

- `.eth`: `setText(bytes32,string,string)` on the name's resolver;
- `.gwei`: `setText(uint256,string,string)` on `NameNFT`.

The user must approve the write in a wallet that controls the name. After a
write, BlobMail must re-read the record from a canonical block and compare the
returned contact code before calling the name configured.

## Evidence and trust

A resolved contact records:

- normalized name;
- namespace (`ens` or `gns`);
- chain ID;
- block number;
- resolver/contract address;
- record key;
- parsed BlobMail identity ID and fingerprint.

This evidence proves what a selected chain and resolver returned at an observed
block. It does not prove that a social-media identity, person, wallet, or sender
controls the messaging key. Users should confirm fingerprints out of band when
that distinction matters.

## References

- [ENS resolution](https://docs.ens.domains/resolution/)
- [ENSIP-5 text records](https://docs.ens.domains/ensip/5/)
- [EIP-137 ENS specification](https://eips.ethereum.org/EIPS/eip-137)
- [Gwei Name Service](https://github.com/lucadonnoh/gwei-names)
