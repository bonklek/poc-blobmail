# BlobMail Loopback milXdy package handoff

This directory is a package-shaped, fixture-only handoff for milXdy App SDK
0.2.4. Its built content entry contains the actual BlobMail Sprint 0 HPKE,
canonical batch, RFE-derived blob reconstruction, digest verification, scan,
and strict text-decryption loop. It has no runtime import outside the package.

It is deliberately disabled by default and does not request host, network,
background, wallet, onchain, signing, transaction, token, AA, P2P, or funded
key access. “Reconstructed” and “decrypted” describe a local in-memory fixture;
they do not mean delivered, read, acknowledged, settled, available on Ethereum,
or canonically included.

## Local package contents

- `milxdy.app.json`: App SDK manifest and user-facing disclosures.
- `dist/content.js`: self-contained ESM content entry generated from the
  verified BlobMail implementation.
- `src/content.js`: milXdy lifecycle and fixture UI adapter source.
- `styles/`: upstream semantic theme tokens plus the BlobMail overlay styles.
- `UPSTREAM_PROVENANCE.json`: exact milXdy commit, source paths, and Git blob
  hashes used for the package shape.
- `UPSTREAM_LICENSE_VPL.txt`: the complete license required by the copied and
  adapted milXdy starter material.
- `tools/verify.mjs`: deterministic, offline permission and artifact verifier.

## Rebuild and verify in BlobMail

From the BlobMail repository root:

```powershell
pnpm exec vite build --config examples/milxdy-blobmail/vite.config.js
node examples/milxdy-blobmail/tools/verify.mjs
```

The build must produce one self-contained `dist/content.js`. The verifier
checks explicit empty permission/background declarations, local-only lifecycle,
storage consent and bounds, asset hashes, required evidence labels, absence of
network/wallet/signing/transaction calls, and pinned upstream provenance.

## Verify and compose in milXdy

Copy this directory into a clean checkout of milXdy at a path such as
`local-addons/manual/blobmail-loopback/`, excluding `src/`, `tools/`, and
`vite.config.js` if only the runtime package is wanted. Retain the README,
provenance, and complete upstream license.

From the milXdy repository root at SDK 0.2.4 or a compatible later version:

```powershell
pnpm.cmd run verify:local-app-package -- --package=local-addons/manual/blobmail-loopback --allow-local-review --acknowledge-package-consent
pnpm.cmd run addons:status
pnpm.cmd run addons:rebuild
```

The acknowledgement is required because the app can optionally persist up to
12 decrypted fixture messages as plaintext. Persistence is off by default,
uses only declared guarded local storage, and the app provides a clear action.

This handoff does not claim that the package has passed milXdy's own repository
verification until those commands run in the target milXdy checkout. The
offline verifier here proves only the package invariants recorded in its JSON
report.
