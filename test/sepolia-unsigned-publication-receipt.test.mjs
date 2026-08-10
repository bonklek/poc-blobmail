import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'
import { loadNodeKzg } from '../src/sidecars/node-kzg.js'
import { bytesToHex, sha256Hex } from '../src/transport/index.js'

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
const forbiddenKeys = /^(?:privateKey|mnemonic|seedPhrase|keystore|signer|wallet|authorization|token|signature|rawTransaction|rpcUrl|headers|submission)$/i

function scanKeys(value, path = '$') {
  if (Array.isArray(value)) return value.forEach((entry, index) => scanKeys(entry, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value)) {
    assert.doesNotMatch(key, forbiddenKeys, `forbidden package key at ${path}.${key}`)
    scanKeys(entry, `${path}.${key}`)
  }
}

test('unsigned publication receipt binds every artifact and contains no secret/signing surface', { timeout: 60_000 }, async () => {
  const report = await readJson('reports/sepolia-unsigned-publication.json')
  assert.ok(['PASS_FIXTURE', 'PASS'].includes(report.result))
  assert.equal(report.chainId, '11155111')
  assert.equal(report.kzgProofVerified, true)
  assert.deepEqual(report.safety, {
    unsigned: true,
    fixturePublisherOnly: true,
    containsSecretMaterial: false,
    containsAuthenticatedEndpoint: false,
    containsSignature: false,
    containsSubmissionCapability: false,
  })
  for (const artifact of report.artifacts) {
    const bytes = new Uint8Array(await readFile(artifact.path))
    assert.equal((await stat(artifact.path)).size, artifact.bytes)
    assert.equal(await sha256Hex(bytes), artifact.sha256)
  }
  const manifest = await readJson('artifacts/sepolia-unsigned-publication-v1/manifest.json')
  const request = await readJson('artifacts/sepolia-unsigned-publication-v1/unsigned-request.json')
  const sidecar = await readJson('artifacts/sepolia-unsigned-publication-v1/blob-sidecar.json')
  scanKeys(manifest)
  scanKeys(request)
  scanKeys(sidecar)
  assert.equal(request.status, 'UNSIGNED_REVIEW_ONLY')
  assert.equal(request.type, '0x3')
  assert.equal(request.chainId, '0xaa36a7')
  assert.equal(request.value, '0x0')
  const blob = new Uint8Array(await readFile('artifacts/sepolia-unsigned-publication-v1/blob-0.bin'))
  assert.equal((await loadNodeKzg()).verifyBlobKZGProof(bytesToHex(blob), sidecar.commitment, sidecar.proof), true)
})

test('publication implementation has no network, environment, wallet, signing, serialization, or submission import surface', async () => {
  const source = await Promise.all([
    'src/publication/canonical-json.js',
    'src/publication/cost.js',
    'src/publication/package.js',
  ].map((path) => readFile(path, 'utf8'))).then((parts) => parts.join('\n'))
  assert.doesNotMatch(source, /node:https|node:http|\bfetch\s*\(|process\.env|dotenv|createWalletClient|privateKeyToAccount|signTransaction|serializeTransaction|eth_send|sendTransaction|sendRawTransaction|sendBundle|child_process|\beval\s*\(|new Function/)
})
