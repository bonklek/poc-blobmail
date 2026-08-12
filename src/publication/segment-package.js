import { bytesToHex, commitmentToVersionedHash, sha256Hex } from '../transport/index.js'
import { packBatch } from '../protocol/index.js'
import {
  BLOBMAIL_CONTENT_TAG,
  SEPOLIA_BSS_CONTRACT,
  createBlobMailSegment,
  createSegmentManifest,
  encodeBlobMailSegmentDeclaration,
} from '../segments/index.js'

export async function createSegmentPublicationPackage({
  entries,
  startFE = 0,
  kzg,
  contractAddress = SEPOLIA_BSS_CONTRACT,
} = {}) {
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError('one or more encrypted entries are required')
  if (!kzg || typeof kzg.blobToKZGCommitment !== 'function'
    || typeof kzg.computeBlobKZGProof !== 'function' || typeof kzg.verifyBlobKZGProof !== 'function') {
    throw new TypeError('an initialized KZG implementation is required')
  }
  const batch = await packBatch(entries)
  const segment = createBlobMailSegment(batch.batchBytes, { startFE })
  const blobHex = bytesToHex(segment.blob)
  const commitment = String(kzg.blobToKZGCommitment(blobHex)).toLowerCase()
  const proof = String(kzg.computeBlobKZGProof(blobHex, commitment)).toLowerCase()
  if (kzg.verifyBlobKZGProof(blobHex, commitment, proof) !== true) {
    throw new Error('generated blob KZG proof failed local verification')
  }
  const versionedHash = await commitmentToVersionedHash(commitment)
  const manifest = createSegmentManifest({
    payloadBytes: batch.batchBytes.byteLength,
    payloadSha256: await sha256Hex(batch.batchBytes),
    batchId: batch.batchId,
    blobVersionedHash: versionedHash,
    startFE: segment.startFE,
    endFE: segment.endFE,
    contractAddress,
    contentTag: BLOBMAIL_CONTENT_TAG,
  })
  const transaction = Object.freeze({
    chainId: manifest.chainId,
    type: '0x3',
    to: manifest.contractAddress,
    value: '0x0',
    data: encodeBlobMailSegmentDeclaration(manifest),
    blobVersionedHashes: Object.freeze([versionedHash]),
  })
  return Object.freeze({
    schema: 'blobmail.segment-publication-package.v1',
    batch: Object.freeze({
      bytes: batch.batchBytes.slice(),
      batchId: batch.batchId,
      entryIds: Object.freeze([...batch.entryIds]),
    }),
    blob: segment.blob.slice(),
    sidecar: Object.freeze({ commitment, proof, versionedHash, kzgProofVerified: true }),
    manifest,
    transaction,
  })
}
