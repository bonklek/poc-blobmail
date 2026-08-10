import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { canonicalJson } from '../src/publication/canonical-json.js'
import { generateUnsignedPublicationPackage } from '../src/publication/package.js'
import { loadNodeKzg } from '../src/sidecars/node-kzg.js'
import { bytesToHex, decodePayloadFromBlobs, hexToBytes } from '../src/transport/index.js'

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))
async function input() {
  const fixture = await readJson('vectors/blobmail-v0.json')
  const config = await readJson('vectors/sepolia-publication-input-v1.json')
  const { schema, ...values } = config
  assert.equal(schema, 'blobmail.sepolia-publication-input.v1')
  return { ...values, batchBytes: hexToBytes(`0x${fixture.batch.batchHex}`) }
}

test('unsigned package generation is byte-for-byte deterministic and independently KZG verified', { timeout: 60_000 }, async () => {
  const kzg = await loadNodeKzg()
  const publicationInput = await input()
  const first = await generateUnsignedPublicationPackage(publicationInput, { kzg })
  const second = await generateUnsignedPublicationPackage(publicationInput, { kzg })
  assert.deepEqual(first.blob, second.blob)
  assert.equal(canonicalJson(first.manifest), canonicalJson(second.manifest))
  assert.equal(first.commitment, kzg.blobToKzgCommitment(bytesToHex(first.blob)).toLowerCase())
  assert.equal(first.proof, kzg.computeBlobKZGProof(bytesToHex(first.blob), first.commitment).toLowerCase())
  assert.equal(kzg.verifyBlobKZGProof(bytesToHex(first.blob), first.commitment, first.proof), true)
  assert.deepEqual(decodePayloadFromBlobs([first.blob], publicationInput.batchBytes.length, { maxBlobs: 1 }), publicationInput.batchBytes)
  assert.equal(first.unsignedRequest.status, 'UNSIGNED_REVIEW_ONLY')
  assert.equal(first.unsignedRequest.value, '0x0')
  assert.equal(first.manifest.blobs.length, 1)
})

test('wrong chain, reorg, secret-shaped fields, malformed batch, and absent KZG fail closed before output', async () => {
  const base = await input()
  await assert.rejects(generateUnsignedPublicationPackage({ ...base, chain: { ...base.chain, id: '1' } }), { code: 'WRONG_CHAIN' })
  await assert.rejects(generateUnsignedPublicationPackage({ ...base, review: { ...base.review, canonicalReferenceBlockHash: `0x${'9'.repeat(64)}` } }), { code: 'REFERENCE_REORGED' })
  await assert.rejects(generateUnsignedPublicationPackage({ ...base, wallet: { privateKey: 'never' } }), { code: 'FORBIDDEN_INPUT' })
  await assert.rejects(generateUnsignedPublicationPackage({ ...base, batchBytes: new Uint8Array([...base.batchBytes, 0]) }), { code: 'INVALID_BATCH_LENGTH' })
  await assert.rejects(generateUnsignedPublicationPackage(base), { code: 'KZG_UNAVAILABLE' })
})

test('invalid generated KZG proof fails closed', async () => {
  const base = await input()
  const kzg = await loadNodeKzg()
  const rejectingKzg = {
    blobToKzgCommitment: (...args) => kzg.blobToKzgCommitment(...args),
    computeBlobKZGProof: (...args) => kzg.computeBlobKZGProof(...args),
    verifyBlobKZGProof: () => false,
  }
  await assert.rejects(generateUnsignedPublicationPackage(base, { kzg: rejectingKzg }), { code: 'KZG_PROOF_INVALID' })
})

test('mutated blob, commitment, and proof do not verify', { timeout: 60_000 }, async () => {
  const kzg = await loadNodeKzg()
  const result = await generateUnsignedPublicationPackage(await input(), { kzg })
  const mutatedBlob = result.blob.slice()
  mutatedBlob[31] ^= 1
  const mutatedCommitment = hexToBytes(result.commitment)
  mutatedCommitment[47] ^= 1
  const mutatedProof = hexToBytes(result.proof)
  mutatedProof[47] ^= 1
  for (const args of [
    [bytesToHex(mutatedBlob), result.commitment, result.proof],
    [bytesToHex(result.blob), bytesToHex(mutatedCommitment), result.proof],
    [bytesToHex(result.blob), result.commitment, bytesToHex(mutatedProof)],
  ]) {
    let verified = false
    try { verified = kzg.verifyBlobKZGProof(...args) } catch {}
    assert.equal(verified, false)
  }
})
