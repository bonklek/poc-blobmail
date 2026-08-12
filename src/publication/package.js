import { parseBatch } from '../protocol/index.js'
import {
  PAYLOAD_BYTES_PER_BLOB,
  bytesToHex,
  commitmentToVersionedHash,
  encodePayloadToBlobs,
  hexToBytes,
  sha256Hex,
} from '../transport/index.js'
import { SEPOLIA_CHAIN_ID, SEPOLIA_GENESIS } from '../network/profile.js'
import { canonicalJsonBytes } from './canonical-json.js'
import { assertFreshReference, calculateCostEnvelope, parseCanonicalUint, publicationFail } from './cost.js'

export const MAX_BLOBMAIL_BATCH_BYTES = 16 + (64 * 616) + 32
export const PUBLICATION_PAYLOAD_LIMIT = Math.min(PAYLOAD_BYTES_PER_BLOB, MAX_BLOBMAIL_BATCH_BYTES)

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const BYTES32 = /^0x[0-9a-fA-F]{64}$/
const SHA256 = /^[0-9a-f]{64}$/
const FORBIDDEN_KEY = /(?:private.?key|mnemonic|seed.?phrase|keystore|signer|wallet|authorization|api.?key|bearer|token|signature|raw.?transaction|rpc.?url|endpoint|headers?)/i

function exactKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) publicationFail('INVALID_SCHEMA', `${label} must be an object`)
  const extra = Object.keys(value).filter((key) => !allowed.includes(key))
  const missing = allowed.filter((key) => !(key in value))
  if (extra.length || missing.length) publicationFail('INVALID_SCHEMA', `${label} keys mismatch (extra: ${extra.join(',') || 'none'}; missing: ${missing.join(',') || 'none'})`)
}

function rejectSecretShaped(value, path = 'input') {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSecretShaped(item, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) publicationFail('FORBIDDEN_INPUT', `${path}.${key} is not allowed`)
      rejectSecretShaped(item, `${path}.${key}`)
    }
    return
  }
  if (typeof value === 'string') {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) || /:\/\/[^/\s]+:[^/@\s]+@/.test(value)) publicationFail('FORBIDDEN_INPUT', `${path} contains credential-shaped text`)
    const words = value.trim().split(/\s+/)
    if (words.length >= 12 && words.every((word) => /^[a-z]+$/i.test(word))) publicationFail('FORBIDDEN_INPUT', `${path} contains phrase-shaped text`)
  }
}

function requireBytes32(value, label) {
  if (!BYTES32.test(String(value ?? ''))) publicationFail('INVALID_HASH', `${label} must be bytes32 hex`)
  return value.toLowerCase()
}

function requireSha(value, label) {
  if (!SHA256.test(String(value ?? ''))) publicationFail('INVALID_DIGEST', `${label} must be lowercase SHA-256 hex`)
  return value
}

function requireAddress(value) {
  if (!ADDRESS.test(String(value ?? ''))) publicationFail('INVALID_PUBLISHER', 'expectedPublisherAddress must be a public address')
  if (/^0x0{40}$/i.test(value)) publicationFail('INVALID_PUBLISHER', 'zero publisher address is not allowed')
  return value.toLowerCase()
}

const quantity = (value) => `0x${BigInt(value).toString(16)}`

function kzgHex(value, label, bytes) {
  const normalized = typeof value === 'string' ? value : bytesToHex(value)
  if (!new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(normalized)) publicationFail('INVALID_KZG_OUTPUT', `${label} must be ${bytes} bytes`)
  return normalized.toLowerCase()
}

export async function generateUnsignedPublicationPackage(input, { kzg } = {}) {
  rejectSecretShaped({ ...input, batchBytes: `[${input.batchBytes?.byteLength ?? 'invalid'} bytes]` })
  exactKeys(input, ['batchBytes', 'caps', 'chain', 'expectedPublisherAddress', 'expiry', 'fees', 'reference', 'review'], 'input')
  if (!(input.batchBytes instanceof Uint8Array)) publicationFail('INVALID_BATCH', 'batchBytes must be Uint8Array')
  exactKeys(input.chain, ['genesisValidatorsRoot', 'id'], 'chain')
  exactKeys(input.reference, ['baseFeePerGasWei', 'blobBaseFeeWei', 'blockHash', 'blockNumber', 'observationArtifactSha256', 'observedAtUnixSeconds', 'publisherNonce'], 'reference')
  exactKeys(input.fees, ['gasLimit', 'maxFeePerBlobGasWei', 'maxFeePerGasWei', 'maxPriorityFeePerGasWei'], 'fees')
  exactKeys(input.caps, ['maxBlobCostWei', 'maxExecutionCostWei', 'maxTotalExposureWei'], 'caps')
  exactKeys(input.expiry, ['validThroughBlock', 'validThroughUnixSeconds'], 'expiry')
  exactKeys(input.review, ['atUnixSeconds', 'canonicalReferenceBlockHash', 'currentBlockNumber'], 'review')
  if (input.chain.id !== String(SEPOLIA_CHAIN_ID)) publicationFail('WRONG_CHAIN', 'only Sepolia chain 11155111 is allowed')
  if (input.chain.genesisValidatorsRoot.toLowerCase() !== SEPOLIA_GENESIS.validatorsRoot) publicationFail('WRONG_GENESIS', 'Sepolia genesis validators root mismatch')
  const publisher = requireAddress(input.expectedPublisherAddress)
  const referenceBlockHash = requireBytes32(input.reference.blockHash, 'reference.blockHash')
  const reviewBlockHash = requireBytes32(input.review.canonicalReferenceBlockHash, 'review.canonicalReferenceBlockHash')
  if (referenceBlockHash !== reviewBlockHash) publicationFail('REFERENCE_REORGED', 'canonical reread does not preserve the fee reference block')
  requireSha(input.reference.observationArtifactSha256, 'reference.observationArtifactSha256')
  assertFreshReference(input)
  const costs = calculateCostEnvelope(input)

  const parsed = await parseBatch(input.batchBytes)
  if (input.batchBytes.byteLength > PUBLICATION_PAYLOAD_LIMIT) publicationFail('PAYLOAD_TOO_LARGE', `batch exceeds the ${PUBLICATION_PAYLOAD_LIMIT}-byte publication limit`)
  const blobs = encodePayloadToBlobs(input.batchBytes, { maxBlobs: 1 })
  if (blobs.length !== 1) publicationFail('BLOB_COUNT_INVALID', 'publication package must contain exactly one blob')
  if (!kzg || typeof kzg.blobToKzgCommitment !== 'function' || typeof kzg.computeBlobKZGProof !== 'function' || typeof kzg.verifyBlobKZGProof !== 'function') publicationFail('KZG_UNAVAILABLE', 'a generation and verification KZG adapter is required')
  const blob = blobs[0]
  const blobHex = bytesToHex(blob)
  const commitment = kzgHex(kzg.blobToKzgCommitment(blobHex), 'commitment', 48)
  const proof = kzgHex(kzg.computeBlobKZGProof(blobHex, commitment), 'proof', 48)
  if (kzg.verifyBlobKZGProof(blobHex, commitment, proof) !== true) publicationFail('KZG_PROOF_INVALID', 'generated KZG proof did not verify')
  const versionedHash = await commitmentToVersionedHash(commitment)
  const batchSha256 = await sha256Hex(input.batchBytes)
  const blobSha256 = await sha256Hex(blob)
  const commitmentSha256 = await sha256Hex(hexToBytes(commitment))
  const proofSha256 = await sha256Hex(hexToBytes(proof))
  const nonce = parseCanonicalUint(input.reference.publisherNonce, 'reference.publisherNonce')
  const gas = parseCanonicalUint(input.fees.gasLimit, 'fees.gasLimit', { allowZero: false })
  const maxFeePerGas = parseCanonicalUint(input.fees.maxFeePerGasWei, 'fees.maxFeePerGasWei', { allowZero: false })
  const priority = parseCanonicalUint(input.fees.maxPriorityFeePerGasWei, 'fees.maxPriorityFeePerGasWei')
  const maxBlobFee = parseCanonicalUint(input.fees.maxFeePerBlobGasWei, 'fees.maxFeePerBlobGasWei', { allowZero: false })
  const unsignedRequest = {
    schema: 'blobmail.unsigned-transaction-request.v1',
    status: 'UNSIGNED_REVIEW_ONLY',
    type: '0x3',
    chainId: '0xaa36a7',
    from: publisher,
    to: publisher,
    value: '0x0',
    nonceEstimate: quantity(nonce),
    gas: quantity(gas),
    maxFeePerGas: quantity(maxFeePerGas),
    maxPriorityFeePerGas: quantity(priority),
    maxFeePerBlobGas: quantity(maxBlobFee),
    blobVersionedHashes: [versionedHash],
    data: '0x',
    blobArtifact: 'blob-0.bin',
  }
  const sidecar = {
    schema: 'blobmail.unsigned-blob-sidecar.v1',
    index: '0',
    blobArtifact: 'blob-0.bin',
    blobBytes: blob.byteLength,
    blobSha256,
    commitment,
    commitmentSha256,
    proof,
    proofSha256,
    versionedHash,
    kzgProofVerified: true,
  }
  const requestBytes = canonicalJsonBytes(unsignedRequest)
  const sidecarBytes = canonicalJsonBytes(sidecar)
  const entries = await Promise.all(parsed.entries.map(async (entryBytes, index) => ({ index, entryId: parsed.entryIds[index], entrySha256: await sha256Hex(entryBytes) })))
  const manifest = {
    schema: 'blobmail.sepolia-unsigned-publication.v1',
    status: 'UNSIGNED_REVIEW_ONLY',
    deterministic: true,
    chain: { id: input.chain.id, genesisValidatorsRoot: input.chain.genesisValidatorsRoot.toLowerCase() },
    expectedPublisherAddress: publisher,
    reference: { ...input.reference, blockHash: referenceBlockHash },
    review: { ...input.review, canonicalReferenceBlockHash: reviewBlockHash },
    expiry: input.expiry,
    fees: input.fees,
    caps: input.caps,
    costs,
    batch: { batchId: parsed.batchId, bytes: input.batchBytes.byteLength, sha256: batchSha256, entries },
    blobs: [sidecar],
    unsignedRequest: { artifact: 'unsigned-request.json', sha256: await sha256Hex(requestBytes) },
    artifacts: {
      batch: { path: 'batch.bin', bytes: input.batchBytes.byteLength, sha256: batchSha256 },
      blob: { path: 'blob-0.bin', bytes: blob.byteLength, sha256: blobSha256 },
      sidecar: { path: 'blob-sidecar.json', bytes: sidecarBytes.byteLength, sha256: await sha256Hex(sidecarBytes) },
      request: { path: 'unsigned-request.json', bytes: requestBytes.byteLength, sha256: await sha256Hex(requestBytes) },
    },
    guarantees: [
      'one canonical blob',
      'KZG proof verified before artifact creation',
      'explicit Sepolia chain and genesis guard',
      'explicit component and total fee caps',
      'no signer, wallet, secret, endpoint, signature, serialization, or submission capability',
    ],
  }
  return Object.freeze({ blob, commitment, manifest, proof, sidecar, unsignedRequest, versionedHash })
}
