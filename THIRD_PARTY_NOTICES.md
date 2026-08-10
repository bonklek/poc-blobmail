# Third-party notices

## ETH Radio

Portions of the BlobMail read-only transport kernel are adapted from the
public [bonklek/eth-radio](https://github.com/bonklek/eth-radio) repository at
commit `b465e02f88bbca85932344228c1cfe5abfb51253`. Detailed file and digest
provenance is recorded in `docs/rfe-transport-provenance.md`.

The upstream work is licensed under the following license, retained here in
its entirety:

```text
VIRAL PUBLIC LICENSE
Copyleft (ɔ) All Rights Reversed

This WORK is hereby relinquished of all associated ownership, attribution and
copy rights, and redistribution or use of any kind, with or without
modification, is permitted without restriction subject to the following
conditions:

1. Redistributions of this WORK, or ANY work that makes use of ANY of the
   contents of this WORK by ANY kind of copying, dependency, linkage, or ANY
   other possible form of DERIVATION or COMBINATION, must retain the ENTIRETY
   of this license.

2. No further restrictions of ANY kind may be applied.
```

## kzg-wasm

BlobMail's fixture and read-only Sepolia sidecar verification uses
`kzg-wasm` version `1.0.0`. The published package metadata declares the
package under the MIT license. Exact package integrity, published `gitHead`,
and runtime artifact digests are recorded in
`reports/sepolia-sidecar-source-provenance.json`.
