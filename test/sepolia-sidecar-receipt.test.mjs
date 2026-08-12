import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalJson(bytes) {
  return Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8'))))
}

test('fixture replay receipt binds full provenance and every adversarial scenario', async () => {
  const receipt = JSON.parse(await readFile('reports/sepolia-sidecar-fixture-replay.json', 'utf8'))
  const vectorBytes = await readFile(receipt.artifacts.vector.path)
  const sourceBytes = await readFile(receipt.artifacts.sourceProvenance.path)
  const expectedCases = [
    'missing',
    'duplicate',
    'reordered-with-unrelated',
    'corrupt-canonical-bytes',
    'wrong-chain',
    'reorged-execution',
    'reorged-beacon',
    'non-finalized',
    'provider-disagreement',
    'invalid-kzg',
    'nonzero-field-prefix',
    'truncated-sidecar',
    'oversized-manifest',
  ]

  assert.equal(receipt.result, 'PASS_FIXTURE')
  assert.equal(receipt.observationMode, 'deterministic-offline-fixture')
  assert.equal(receipt.provenance.chainId, 11_155_111)
  assert.equal(receipt.provenance.providerIds.length, 2)
  assert.equal(receipt.sidecars.commitments.length, 1)
  assert.equal(receipt.sidecars.proofs.length, 1)
  assert.deepEqual(receipt.evidence.map(({ state }) => state), [
    'BLOB_TRANSACTION_INCLUDED',
    'SIDECARS_MATCHED',
    'KZG_PROOF_VERIFIED',
    'BATCH_RECONSTRUCTED',
    'PAYLOAD_SHA256_VERIFIED',
  ])
  assert.deepEqual(receipt.adversarialCases.map(({ name }) => name), expectedCases)
  assert.equal(sha256(canonicalJson(vectorBytes)), receipt.artifacts.vector.sha256)
  assert.equal(sha256(canonicalJson(sourceBytes)), receipt.artifacts.sourceProvenance.sha256)
  assert.equal(receipt.negativeClaims.liveNetworkObserved, false)
  assert.equal(receipt.negativeClaims.transactionSubmitted, false)
})

test('sidecar receipts and vectors contain no credential-shaped or signing material', async () => {
  const paths = [
    'vectors/sepolia-sidecar-replay-v1.json',
    'reports/sepolia-sidecar-source-provenance.json',
    'reports/sepolia-sidecar-fixture-replay.json',
  ]
  const documents = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, 'utf8'))))
  const strings = []
  const visit = (value) => {
    if (typeof value === 'string') strings.push(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  documents.forEach(visit)
  const contents = strings.join('\n')
  assert.doesNotMatch(contents, /private[_-]?key|mnemonic|seed phrase|raw signed|bearer\s+[a-z0-9]/i)
  assert.doesNotMatch(contents, /https:\/\/[^/\s"']*[?@][^\s"']*/i)
})
