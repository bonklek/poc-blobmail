import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BLOB_BYTES,
  MAX_BLOBS_PER_BATCH,
  PAYLOAD_BYTES_PER_BLOB,
  TRANSPORT_EVIDENCE_STATES,
  TransportIntegrityError,
  bytesToHex,
  commitmentToVersionedHash,
  decodePayloadFromBlobSegment,
  decodePayloadFromBlobs,
  encodePayloadToBlobs,
  reconstructAndVerifyPayload,
  selectSidecarsByVersionedHash,
  sha256Hex,
  sidecarCacheKey,
  segmentPayloadCapacity,
  writePayloadToBlobSegment,
} from '../src/transport/index.js'

const PUBLIC_RFE_VECTOR = Object.freeze({
  commitment: `0x${'11'.repeat(48)}`,
  versionedHash: '0x01a127dff9f9bbfa1dff5275a99464123998e95bf11dd579f2ffcab301bc7350',
})

function fixturePayload(length) {
  return Uint8Array.from({ length }, (_, index) => (index * 37 + 11) % 256)
}

test('31-byte field-element encoding round-trips across a blob boundary', () => {
  const payload = fixturePayload(PAYLOAD_BYTES_PER_BLOB + 9)
  const blobs = encodePayloadToBlobs(payload)

  assert.equal(blobs.length, 2)
  assert.equal(blobs[0].byteLength, BLOB_BYTES)
  assert.equal(blobs[0][0], 0)
  assert.equal(blobs[0][32], 0)
  assert.equal(blobs[0][1], payload[0])
  assert.equal(blobs[0][31], payload[30])
  assert.deepEqual(decodePayloadFromBlobs(blobs, payload.byteLength), payload)
})

test('decoder rejects a non-zero field-element prefix', () => {
  const [blob] = encodePayloadToBlobs(new Uint8Array([1, 2, 3]))
  blob[32] = 1
  assert.throws(
    () => decodePayloadFromBlobs([blob], 3),
    /invalid blob field element prefix at blob 0, byte offset 32/,
  )
})

test('ERC-8179-style segment encoding preserves unrelated field elements', () => {
  const original = new Uint8Array(BLOB_BYTES)
  original.fill(0xa5, 1, 32)
  original.fill(0x5a, 7 * 32 + 1, 8 * 32)
  const payload = fixturePayload(70)
  const encoded = writePayloadToBlobSegment(original, payload, { startFE: 3, endFE: 7 })

  assert.deepEqual(encoded.subarray(0, 3 * 32), original.subarray(0, 3 * 32))
  assert.deepEqual(encoded.subarray(7 * 32, 8 * 32), original.subarray(7 * 32, 8 * 32))
  assert.equal(segmentPayloadCapacity(3, 7), 124)
  assert.deepEqual(
    decodePayloadFromBlobSegment(encoded, payload.byteLength, { startFE: 3, endFE: 7 }),
    payload,
  )
})

test('segment decoding rejects invalid ranges, excess payload, and non-canonical padding', () => {
  const blob = new Uint8Array(BLOB_BYTES)
  assert.throws(
    () => writePayloadToBlobSegment(blob, new Uint8Array(), { startFE: 10, endFE: 10 }),
    /field-element segment/,
  )
  assert.throws(
    () => writePayloadToBlobSegment(blob, new Uint8Array(32), { startFE: 10, endFE: 11 }),
    /exceeds decoded capacity 31/,
  )

  const encoded = writePayloadToBlobSegment(blob, new Uint8Array([1]), { startFE: 10, endFE: 11 })
  encoded[10 * 32 + 2] = 1
  assert.throws(
    () => decodePayloadFromBlobSegment(encoded, 1, { startFE: 10, endFE: 11 }),
    /non-zero padding/,
  )
})

test('encoder and decoder enforce explicit bounded work', () => {
  assert.throws(
    () => encodePayloadToBlobs(new Uint8Array(PAYLOAD_BYTES_PER_BLOB + 1), { maxBlobs: 1 }),
    /payload requires 2 blobs; limit is 1/,
  )
  assert.throws(
    () => decodePayloadFromBlobs([], 1),
    /payloadBytes 1 exceeds decoded capacity 0/,
  )
  assert.throws(
    () => decodePayloadFromBlobs([new Uint8Array(BLOB_BYTES)], 0),
    /payloadBytes 0 requires exactly 0 blobs, got 1/,
  )
  assert.throws(
    () => encodePayloadToBlobs(new Uint8Array(), { maxBlobs: MAX_BLOBS_PER_BATCH + 1 }),
    /maxBlobs/,
  )
})

test('commitment-to-versioned-hash matches a fixed fixture vector', async () => {
  assert.equal(await commitmentToVersionedHash(PUBLIC_RFE_VECTOR.commitment), PUBLIC_RFE_VECTOR.versionedHash)
})

test('strict sidecar selection derives hashes, verifies supplied hashes, and restores manifest order', async () => {
  const payload = fixturePayload(PAYLOAD_BYTES_PER_BLOB + 1)
  const blobs = encodePayloadToBlobs(payload)
  const commitments = [`0x${'22'.repeat(48)}`, `0x${'33'.repeat(48)}`]
  const hashes = await Promise.all(commitments.map(commitmentToVersionedHash))
  const sidecars = [
    { index: 8, kzg_commitment: commitments[1], versionedHash: hashes[1], blob: blobs[1] },
    { index: 7, kzgCommitment: commitments[0], versionedHash: hashes[0].toUpperCase().replace('0X', '0x'), blob: bytesToHex(blobs[0]) },
  ]

  const selected = await selectSidecarsByVersionedHash(hashes, sidecars)
  assert.deepEqual(selected.map(({ index }) => index), [7, 8])
  assert.deepEqual(selected.map(({ versionedHash }) => versionedHash), hashes)
})

test('strict sidecar selection rejects commitment mismatch, duplicates, and missing sidecars', async () => {
  const [blob] = encodePayloadToBlobs(new Uint8Array([1]))
  const commitment = `0x${'44'.repeat(48)}`
  const expected = await commitmentToVersionedHash(commitment)
  const wrong = `0x${'55'.repeat(32)}`

  await assert.rejects(
    selectSidecarsByVersionedHash([expected], [{ commitment, versionedHash: wrong, blob }]),
    (error) => error instanceof TransportIntegrityError && error.code === 'SIDECAR_HASH_MISMATCH',
  )
  await assert.rejects(
    selectSidecarsByVersionedHash([expected], [{ commitment, blob }, { commitment, blob }]),
    (error) => error instanceof TransportIntegrityError && error.code === 'DUPLICATE_SIDECAR',
  )
  await assert.rejects(
    selectSidecarsByVersionedHash([wrong], [{ commitment, blob }]),
    (error) => error instanceof TransportIntegrityError && error.code === 'MISSING_SIDECAR',
  )
})

test('reconstruction emits staged evidence only after each check succeeds', async () => {
  const payload = new TextEncoder().encode('blobmail loopback fixture')
  const [blob] = encodePayloadToBlobs(payload)
  const commitment = `0x${'66'.repeat(48)}`
  const versionedHash = await commitmentToVersionedHash(commitment)
  const payloadSha256 = await sha256Hex(payload)
  const manifest = { payloadBytes: payload.length, payloadSha256, blobVersionedHashes: [versionedHash] }
  const sidecars = [{ index: 0, commitment, blob }]

  const result = await reconstructAndVerifyPayload(manifest, sidecars)
  assert.deepEqual(result.payload, payload)
  assert.equal(result.payloadSha256, payloadSha256)
  assert.deepEqual(
    result.evidence.map(({ state }) => state),
    [
      TRANSPORT_EVIDENCE_STATES.SIDECARS_MATCHED,
      TRANSPORT_EVIDENCE_STATES.BATCH_RECONSTRUCTED,
      TRANSPORT_EVIDENCE_STATES.PAYLOAD_SHA256_VERIFIED,
    ],
  )
  assert.equal(result.evidence[0].details.commitmentHashVerified, true)
  assert.equal(result.evidence[0].details.kzgProofVerified, false)

  await assert.rejects(
    reconstructAndVerifyPayload({ ...manifest, payloadSha256: '00'.repeat(32) }, sidecars),
    (error) => {
      assert.ok(error instanceof TransportIntegrityError)
      assert.equal(error.code, 'PAYLOAD_SHA256_MISMATCH')
      assert.deepEqual(
        error.evidence.map(({ state }) => state),
        [TRANSPORT_EVIDENCE_STATES.SIDECARS_MATCHED, TRANSPORT_EVIDENCE_STATES.BATCH_RECONSTRUCTED],
      )
      return true
    },
  )
  await assert.rejects(
    reconstructAndVerifyPayload({ ...manifest, blobCount: 2 }, sidecars),
    (error) => error instanceof TransportIntegrityError && error.code === 'BLOB_COUNT_MISMATCH',
  )
})

test('cache keys are deterministic, ordered, and do not depend on mutable storage', () => {
  const key = sidecarCacheKey({
    chainId: 11155111n,
    slot: '123456',
    versionedHashes: [PUBLIC_RFE_VECTOR.versionedHash],
  })
  assert.equal(
    key,
    `blobmail:sidecars:v1:11155111:123456:${PUBLIC_RFE_VECTOR.versionedHash}`,
  )
})
