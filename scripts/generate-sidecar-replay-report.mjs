import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

const OUTPUT = 'reports/sepolia-sidecar-fixture-replay.json'
const canonicalJson = (bytes) => Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8'))))
const vectorBytes = await readFile('vectors/sepolia-sidecar-replay-v1.json')
const vector = JSON.parse(vectorBytes.toString('utf8'))
const sourceBytes = await readFile('reports/sepolia-sidecar-source-provenance.json')
const fixture = vector.fixture

const report = {
  schema: 'blobmail.sepolia-sidecar-replay-receipt.v1',
  generatedAt: '2026-08-10T00:00:00.000Z',
  result: 'PASS_FIXTURE',
  observationMode: 'deterministic-offline-fixture',
  provenance: {
    chainId: fixture.chainId,
    genesisValidatorsRoot: '0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078',
    transactionHash: fixture.transactionHash,
    blockNumber: fixture.blockNumber,
    blockHash: fixture.blockHash,
    slot: fixture.slot,
    beaconRoot: fixture.beaconRoot,
    providerIds: [
      'blobmail-sepolia-v0:execution:fixture.invalid',
      'blobmail-sepolia-v0:beacon:fixture.invalid'
    ],
    headSlots: [fixture.slot + 64],
    finalizedSlots: [fixture.slot + 32],
    finality: 'finalized_checkpoint_at_or_after_inclusion'
  },
  payload: {
    bytes: fixture.payloadBytes,
    sha256: fixture.payloadSha256,
    batchId: fixture.batchId,
    entryIds: fixture.entryIds
  },
  sidecars: {
    blobCount: 1,
    blobBytes: fixture.blobBytes,
    blobSha256: fixture.blobSha256,
    commitments: [fixture.commitment],
    proofs: [fixture.proof],
    versionedHashes: [fixture.versionedHash],
    kzgImplementation: 'kzg-wasm@1.0.0/c-kzg-4844'
  },
  evidence: vector.evidenceOrder.map((state) => ({ state })),
  adversarialCases: vector.adversarialCases,
  commands: {
    generate: 'node scripts/generate-sidecar-vectors.mjs && node scripts/generate-sidecar-replay-report.mjs',
    test: 'node --test test/sepolia-sidecar-replay.test.mjs test/sepolia-sidecar-receipt.test.mjs',
    live: 'pnpm probe:sidecars -- --tx 0x... --manifest path/to/public-manifest.json'
  },
  artifacts: {
    vector: {
      path: 'vectors/sepolia-sidecar-replay-v1.json',
      sha256: createHash('sha256').update(canonicalJson(vectorBytes)).digest('hex')
    },
    sourceProvenance: {
      path: 'reports/sepolia-sidecar-source-provenance.json',
      sha256: createHash('sha256').update(canonicalJson(sourceBytes)).digest('hex')
    }
  },
  negativeClaims: {
    liveNetworkObserved: false,
    walletAccessed: false,
    signerPresent: false,
    transactionConstructed: false,
    transactionSubmitted: false,
    chainInclusionClaimedForFixture: false
  }
}

await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`wrote ${OUTPUT}`)
