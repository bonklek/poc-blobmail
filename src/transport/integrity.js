/*
 * Adapted from the public eth-radio read path at commit
 * b465e02f88bbca85932344228c1cfe5abfb51253.
 * Licensed under the Viral Public License; see THIRD_PARTY_NOTICES.md.
 * This module verifies supplied bytes only; it performs no network I/O.
 */

import { BLOB_BYTES, MAX_BLOBS_PER_BATCH, decodePayloadFromBlobs } from './blob-codec.js'

const HEX_BYTE_PATTERN = /^(?:[0-9a-fA-F]{2})*$/
const VERSIONED_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/
const COMMITMENT_PATTERN = /^0x[0-9a-fA-F]{96}$/
const SHA256_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/

export const TRANSPORT_EVIDENCE_STATES = Object.freeze({
  SIDECARS_MATCHED: 'SIDECARS_MATCHED',
  BATCH_RECONSTRUCTED: 'BATCH_RECONSTRUCTED',
  PAYLOAD_SHA256_VERIFIED: 'PAYLOAD_SHA256_VERIFIED',
})

export class TransportIntegrityError extends Error {
  constructor(code, message, evidence = []) {
    super(message)
    this.name = 'TransportIntegrityError'
    this.code = code
    this.evidence = evidence
  }
}

function copyBytes(value, label) {
  if (value instanceof Uint8Array) return value.slice()
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
  }
  if (typeof value === 'string') return hexToBytes(value, label)
  throw new TypeError(`${label} must be byte hex or a byte array`)
}

export function hexToBytes(value, label = 'hex value') {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new TypeError(`${label} must be 0x-prefixed byte hex`)
  }
  const hex = value.slice(2)
  if (!HEX_BYTE_PATTERN.test(hex)) throw new TypeError(`${label} must be valid byte hex`)
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

export function bytesToHex(value) {
  const bytes = copyBytes(value, 'bytes')
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function normalizeVersionedHash(value, label = 'versioned hash') {
  if (!VERSIONED_HASH_PATTERN.test(String(value ?? ''))) {
    throw new TypeError(`${label} must be a 32-byte 0x-prefixed hex value`)
  }
  return value.toLowerCase()
}

function normalizeCommitment(value, label = 'KZG commitment') {
  if (!COMMITMENT_PATTERN.test(String(value ?? ''))) {
    throw new TypeError(`${label} must be a 48-byte 0x-prefixed hex value`)
  }
  return value.toLowerCase()
}

function normalizeSha256(value, label = 'payloadSha256') {
  if (!SHA256_PATTERN.test(String(value ?? ''))) {
    throw new TypeError(`${label} must be a 32-byte hex digest`)
  }
  return value.toLowerCase().replace(/^0x/, '')
}

function assertBound(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer between 0 and ${maximum}`)
  }
}

function sidecarIndex(value, fallback, label) {
  const index = value ?? fallback
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
  return index
}

function sha256Subtle() {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Web Crypto SHA-256 is unavailable in this runtime')
  return subtle
}

export async function sha256Hex(value) {
  const bytes = copyBytes(value, 'SHA-256 input')
  const digest = await sha256Subtle().digest('SHA-256', bytes)
  return bytesToHex(new Uint8Array(digest)).slice(2)
}

/** Implements EIP-4844 kzg_to_versioned_hash for a supplied commitment. */
export async function commitmentToVersionedHash(commitment) {
  const normalized = normalizeCommitment(commitment)
  const digest = hexToBytes(`0x${await sha256Hex(hexToBytes(normalized))}`)
  digest[0] = 1
  return bytesToHex(digest)
}

/**
 * Matches an ordered manifest hash list against an unordered bounded sidecar
 * set. Every match is derived from its KZG commitment. A sidecar-supplied
 * versionedHash, when present, must agree with that derivation.
 *
 * This intentionally does not claim KZG proof verification. Consumers that
 * need proof verification must add a trusted KZG verifier before advancing
 * beyond SIDECARS_MATCHED.
 */
export async function selectSidecarsByVersionedHash(
  expectedVersionedHashes,
  sidecars,
  { maxBlobs = MAX_BLOBS_PER_BATCH, maxSidecars = 64 } = {},
) {
  assertBound(maxBlobs, 'maxBlobs', MAX_BLOBS_PER_BATCH)
  assertBound(maxSidecars, 'maxSidecars', 4096)
  if (!Array.isArray(expectedVersionedHashes)) throw new TypeError('expectedVersionedHashes must be an array')
  if (!Array.isArray(sidecars)) throw new TypeError('sidecars must be an array')
  if (expectedVersionedHashes.length > maxBlobs) {
    throw new RangeError(`expected hash count ${expectedVersionedHashes.length} exceeds limit ${maxBlobs}`)
  }
  if (sidecars.length > maxSidecars) {
    throw new RangeError(`sidecar count ${sidecars.length} exceeds limit ${maxSidecars}`)
  }

  const expected = expectedVersionedHashes.map((hash, index) => normalizeVersionedHash(hash, `expected hash ${index}`))
  if (new Set(expected).size !== expected.length) {
    throw new TransportIntegrityError('DUPLICATE_EXPECTED_HASH', 'expectedVersionedHashes must not contain duplicates')
  }
  const wanted = new Set(expected)
  const matched = new Map()

  for (const [index, candidate] of sidecars.entries()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError(`sidecar ${index} must be an object`)
    }
    const commitment = normalizeCommitment(
      candidate.kzg_commitment ?? candidate.kzgCommitment ?? candidate.commitment,
      `sidecar ${index} KZG commitment`,
    )
    const derivedHash = await commitmentToVersionedHash(commitment)
    if (candidate.versionedHash !== undefined && candidate.versionedHash !== null) {
      const suppliedHash = normalizeVersionedHash(candidate.versionedHash, `sidecar ${index} versionedHash`)
      if (suppliedHash !== derivedHash) {
        throw new TransportIntegrityError(
          'SIDECAR_HASH_MISMATCH',
          `sidecar ${index} versionedHash does not match its KZG commitment`,
        )
      }
    }
    if (!wanted.has(derivedHash)) continue
    if (matched.has(derivedHash)) {
      throw new TransportIntegrityError('DUPLICATE_SIDECAR', `multiple sidecars match ${derivedHash}`)
    }

    const blob = copyBytes(candidate.blob, `sidecar ${index} blob`)
    if (blob.byteLength !== BLOB_BYTES) {
      throw new RangeError(`sidecar ${index} blob must contain exactly ${BLOB_BYTES} bytes`)
    }
    matched.set(derivedHash, Object.freeze({
      index: sidecarIndex(candidate.index, index, `sidecar ${index} index`),
      versionedHash: derivedHash,
      commitment,
      blob,
      kzgProof: candidate.kzg_proof ?? candidate.kzgProof ?? null,
    }))
  }

  const missing = expected.filter((hash) => !matched.has(hash))
  if (missing.length > 0) {
    throw new TransportIntegrityError('MISSING_SIDECAR', `missing sidecar for ${missing.join(', ')}`)
  }
  return expected.map((hash) => matched.get(hash))
}

function normalizeManifest(manifest, maxBlobs) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('manifest must be an object')
  }
  if (!Number.isSafeInteger(manifest.payloadBytes) || manifest.payloadBytes < 0) {
    throw new RangeError('manifest.payloadBytes must be a non-negative safe integer')
  }
  if (!Array.isArray(manifest.blobVersionedHashes)) {
    throw new TypeError('manifest.blobVersionedHashes must be an array')
  }
  if (manifest.blobVersionedHashes.length > maxBlobs) {
    throw new RangeError(`manifest blob count exceeds limit ${maxBlobs}`)
  }
  if (manifest.blobCount !== undefined
    && (!Number.isSafeInteger(manifest.blobCount) || manifest.blobCount < 0)) {
    throw new RangeError('manifest.blobCount must be a non-negative safe integer when present')
  }
  if (manifest.blobCount !== undefined && manifest.blobCount !== manifest.blobVersionedHashes.length) {
    throw new TransportIntegrityError(
      'BLOB_COUNT_MISMATCH',
      `manifest.blobCount ${manifest.blobCount} does not match ${manifest.blobVersionedHashes.length} versioned hashes`,
    )
  }
  return {
    payloadBytes: manifest.payloadBytes,
    payloadSha256: normalizeSha256(manifest.payloadSha256),
    blobVersionedHashes: manifest.blobVersionedHashes,
  }
}

function evidence(state, details) {
  return Object.freeze({ state, details: Object.freeze(details) })
}

/** Strictly selects, reconstructs, and hashes a payload without network I/O. */
export async function reconstructAndVerifyPayload(
  manifest,
  sidecars,
  { maxBlobs = MAX_BLOBS_PER_BATCH, maxSidecars = 64 } = {},
) {
  assertBound(maxBlobs, 'maxBlobs', MAX_BLOBS_PER_BATCH)
  const normalizedManifest = normalizeManifest(manifest, maxBlobs)
  const completedEvidence = []
  const matches = await selectSidecarsByVersionedHash(
    normalizedManifest.blobVersionedHashes,
    sidecars,
    { maxBlobs, maxSidecars },
  )
  completedEvidence.push(evidence(TRANSPORT_EVIDENCE_STATES.SIDECARS_MATCHED, {
    blobCount: matches.length,
    versionedHashes: matches.map((match) => match.versionedHash),
    commitmentHashVerified: true,
    kzgProofVerified: false,
  }))

  const payload = decodePayloadFromBlobs(matches.map((match) => match.blob), normalizedManifest.payloadBytes, { maxBlobs })
  completedEvidence.push(evidence(TRANSPORT_EVIDENCE_STATES.BATCH_RECONSTRUCTED, {
    payloadBytes: payload.byteLength,
    encoding: '31-byte-data-per-field-element',
  }))

  const actualSha256 = await sha256Hex(payload)
  if (actualSha256 !== normalizedManifest.payloadSha256) {
    throw new TransportIntegrityError(
      'PAYLOAD_SHA256_MISMATCH',
      `payload SHA-256 mismatch: expected ${normalizedManifest.payloadSha256}, got ${actualSha256}`,
      completedEvidence,
    )
  }
  completedEvidence.push(evidence(TRANSPORT_EVIDENCE_STATES.PAYLOAD_SHA256_VERIFIED, {
    payloadSha256: actualSha256,
  }))

  return Object.freeze({
    payload,
    payloadSha256: actualSha256,
    evidence: Object.freeze(completedEvidence),
  })
}

function decimalString(value, label) {
  const normalized = String(value)
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) throw new TypeError(`${label} must be a non-negative decimal integer`)
  return normalized
}

/** Deterministic key for caller-owned memory or IndexedDB caches. */
export function sidecarCacheKey({ chainId, slot, versionedHashes }) {
  if (!Array.isArray(versionedHashes)) throw new TypeError('versionedHashes must be an array')
  if (versionedHashes.length > MAX_BLOBS_PER_BATCH) {
    throw new RangeError(`versioned hash count exceeds limit ${MAX_BLOBS_PER_BATCH}`)
  }
  const hashes = versionedHashes.map((hash, index) => normalizeVersionedHash(hash, `versioned hash ${index}`))
  if (new Set(hashes).size !== hashes.length) {
    throw new TransportIntegrityError('DUPLICATE_EXPECTED_HASH', 'versionedHashes must not contain duplicates')
  }
  return `blobmail:sidecars:v1:${decimalString(chainId, 'chainId')}:${decimalString(slot, 'slot')}:${hashes.join(',')}`
}
