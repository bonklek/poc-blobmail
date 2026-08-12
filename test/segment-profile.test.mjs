import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeFunctionData, encodeEventTopics, encodeAbiParameters } from 'viem'
import { packBatch } from '../src/protocol/index.js'
import { sha256Hex } from '../src/transport/index.js'
import {
  BLOBMAIL_CONTENT_TAG,
  BLOBMAIL_SEGMENT_SCHEMA,
  BSS_ABI,
  SEPOLIA_BSS_CONTRACT,
  createBlobMailSegment,
  createSegmentManifest,
  decodeBlobMailBatchFromDeclaredSegment,
  decodeBlobMailSegment,
  encodeBlobMailSegmentDeclaration,
  parseBlobMailSegmentDeclaration,
} from '../src/segments/index.js'
import vector from '../vectors/blobmail-v0.json' with { type: 'json' }

function hexToBytes(value) {
  return Uint8Array.from(value.match(/../gu), (byte) => Number.parseInt(byte, 16))
}

test('segment profile packs a canonical batch at a nonzero FE offset and preserves neighbors', async () => {
  const entry = hexToBytes(vector.encryption.entryHex)
  const batch = await packBatch([entry])
  const base = new Uint8Array(131072)
  base[1] = 0xaa
  base[4095 * 32 + 1] = 0xbb
  const segment = createBlobMailSegment(batch.batchBytes, { startFE: 100, blob: base })

  assert.equal(segment.startFE, 100)
  assert.equal(segment.endFE, 122)
  assert.equal(segment.blob[1], 0xaa)
  assert.equal(segment.blob[4095 * 32 + 1], 0xbb)
  const manifest = createSegmentManifest({
    payloadBytes: batch.batchBytes.byteLength,
    payloadSha256: await sha256Hex(batch.batchBytes),
    batchId: batch.batchId,
    blobVersionedHash: `0x${'11'.repeat(32)}`,
    startFE: segment.startFE,
    endFE: segment.endFE,
  })
  assert.equal(manifest.schema, BLOBMAIL_SEGMENT_SCHEMA)
  assert.deepEqual(decodeBlobMailSegment(segment.blob, manifest), batch.batchBytes)
  assert.equal((await decodeBlobMailBatchFromDeclaredSegment(segment.blob, segment)).batchId, batch.batchId)
})

test('segment declaration calldata binds the exact canonical range and content tag', () => {
  const manifest = createSegmentManifest({
    payloadBytes: 31,
    payloadSha256: '22'.repeat(32),
    batchId: '33'.repeat(32),
    blobVersionedHash: `0x${'44'.repeat(32)}`,
    startFE: 2000,
    endFE: 2001,
  })
  const decoded = decodeFunctionData({ abi: BSS_ABI, data: encodeBlobMailSegmentDeclaration(manifest) })
  assert.equal(decoded.functionName, 'declareBlobSegment')
  assert.deepEqual(decoded.args, [0n, 2000, 2001, BLOBMAIL_CONTENT_TAG])
})

test('event parser accepts only the pinned contract, content tag, and valid range', () => {
  const versionedHash = `0x${'55'.repeat(32)}`
  const declarer = '0x1111111111111111111111111111111111111111'
  const topics = encodeEventTopics({
    abi: BSS_ABI,
    eventName: 'BlobSegmentDeclared',
    args: { versionedHash, declarer, contentTag: BLOBMAIL_CONTENT_TAG },
  })
  const data = encodeAbiParameters([{ type: 'uint16' }, { type: 'uint16' }], [10, 20])
  const log = { address: SEPOLIA_BSS_CONTRACT, topics, data }
  const parsed = parseBlobMailSegmentDeclaration(log)
  assert.equal(parsed.versionedHash, versionedHash)
  assert.equal(parsed.startFE, 10)
  assert.equal(parsed.endFE, 20)

  assert.throws(
    () => parseBlobMailSegmentDeclaration({ ...log, address: declarer }),
    /untrusted contract/u,
  )
  const otherTopics = encodeEventTopics({
    abi: BSS_ABI,
    eventName: 'BlobSegmentDeclared',
    args: { versionedHash, declarer, contentTag: `0x${'66'.repeat(32)}` },
  })
  assert.throws(
    () => parseBlobMailSegmentDeclaration({ ...log, topics: otherTopics }),
    /another content tag/u,
  )
})

test('segment manifests reject spare claimed field elements and overflow', () => {
  const base = {
    payloadBytes: 31,
    payloadSha256: '22'.repeat(32),
    batchId: '33'.repeat(32),
    blobVersionedHash: `0x${'44'.repeat(32)}`,
    startFE: 0,
  }
  assert.throws(() => createSegmentManifest({ ...base, endFE: 2 }), /minimal canonical range/u)
  assert.throws(() => createBlobMailSegment(new Uint8Array(32), { startFE: 4095 }), /does not fit/u)
})

test('declared-segment batch discovery rejects nonzero bytes after the self-described batch', async () => {
  const batchBytes = hexToBytes(vector.batch.batchHex)
  const segment = createBlobMailSegment(batchBytes, { startFE: 50 })
  segment.blob[(segment.endFE - 1) * 32 + 31] = 1
  await assert.rejects(
    decodeBlobMailBatchFromDeclaredSegment(segment.blob, segment),
    /non-zero padding/u,
  )
})
