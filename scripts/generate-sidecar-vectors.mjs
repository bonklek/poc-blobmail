import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { deriveIdentity, encryptText, packBatch } from '../src/protocol/index.js'
import { loadNodeKzg } from '../src/sidecars/index.js'
import {
  bytesToHex,
  commitmentToVersionedHash,
  encodePayloadToBlobs,
  sha256Hex,
} from '../src/transport/index.js'

const OUTPUT = 'vectors/sepolia-sidecar-replay-v1.json'
const canonicalJson = (bytes) => Buffer.from(JSON.stringify(JSON.parse(bytes.toString('utf8'))))
const kzg = await loadNodeKzg()
const recipient = await deriveIdentity(new Uint8Array(32).fill(2))
const encrypted = await encryptText({
  text: 'Sepolia sidecar replay fixture',
  recipientIdentity: recipient,
  ephemeralSeed: new Uint8Array(32).fill(3),
})
const batch = await packBatch([encrypted.entryBytes])
const [blob] = encodePayloadToBlobs(batch.batchBytes, { maxBlobs: 1 })
const blobHex = bytesToHex(blob)
const commitment = kzg.blobToKZGCommitment(blobHex).toLowerCase()
const proof = kzg.computeBlobKZGProof(blobHex, commitment).toLowerCase()
const provenanceBytes = await readFile('reports/sepolia-sidecar-source-provenance.json')

const vector = {
  schema: 'blobmail.sepolia-sidecar-vector.v1',
  fixture: {
    derivation: {
      recipientSeedByte: 2,
      ephemeralSeedByte: 3,
      plaintext: 'Sepolia sidecar replay fixture',
    },
    chainId: 11155111,
    transactionHash: `0x${'11'.repeat(32)}`,
    blockNumber: 9900000,
    blockHash: `0x${'22'.repeat(32)}`,
    slot: 8800000,
    beaconRoot: `0x${'33'.repeat(32)}`,
    payloadBytes: batch.batchBytes.byteLength,
    payloadSha256: await sha256Hex(batch.batchBytes),
    batchId: batch.batchId,
    entryIds: batch.entryIds,
    blobBytes: blob.byteLength,
    blobSha256: await sha256Hex(blob),
    commitment,
    proof,
    versionedHash: await commitmentToVersionedHash(commitment),
  },
  evidenceOrder: [
    'BLOB_TRANSACTION_INCLUDED',
    'SIDECARS_MATCHED',
    'KZG_PROOF_VERIFIED',
    'BATCH_RECONSTRUCTED',
    'PAYLOAD_SHA256_VERIFIED',
  ],
  adversarialCases: [
    { name: 'missing', expectedError: 'MISSING_SIDECAR', completedEvidence: 1 },
    { name: 'duplicate', expectedError: 'DUPLICATE_SIDECAR', completedEvidence: 1 },
    { name: 'reordered-with-unrelated', expectedResult: 'PASS' },
    { name: 'corrupt-canonical-bytes', expectedError: 'PAYLOAD_SHA256_MISMATCH', completedEvidence: 4 },
    { name: 'wrong-chain', expectedError: 'CHAIN_ID_MISMATCH', completedEvidence: 0 },
    { name: 'reorged-execution', expectedError: 'REORGED_BLOCK', completedEvidence: 0 },
    { name: 'reorged-beacon', expectedError: 'REORGED_BLOCK', completedEvidence: 0 },
    { name: 'non-finalized', expectedResult: 'PASS', finality: 'not_finalized_at_observation' },
    { name: 'provider-disagreement', expectedError: 'PROVIDER_DISAGREEMENT', completedEvidence: 0 },
    { name: 'invalid-kzg', expectedError: 'INVALID_KZG_PROOF', completedEvidence: 2 },
    { name: 'nonzero-field-prefix', expectedError: 'BATCH_RECONSTRUCTION_FAILED', completedEvidence: 3 },
    { name: 'truncated-sidecar', expectedError: 'INVALID_SIDECARS', completedEvidence: 1 },
    { name: 'oversized-manifest', expectedError: 'INVALID_MANIFEST', completedEvidence: 0 },
  ],
  independentVector: {
    zeroBlobSha256: 'fa43239bcee7b97ca62f007cc68487560a39e19f74f3dde7486db3f98df8e471',
    pointAtInfinity: `0xC0${'00'.repeat(47)}`,
  },
  provenance: {
    sourceReport: 'reports/sepolia-sidecar-source-provenance.json',
    sourceReportSha256: createHash('sha256').update(canonicalJson(provenanceBytes)).digest('hex'),
    executableTest: 'test/sepolia-sidecar-replay.test.mjs',
  },
}

await writeFile(OUTPUT, `${JSON.stringify(vector, null, 2)}\n`, 'utf8')
console.log(`wrote ${OUTPUT} (${vector.fixture.blobBytes}-byte KZG blob)`)
