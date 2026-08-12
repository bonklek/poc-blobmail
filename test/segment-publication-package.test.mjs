import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeFunctionData } from 'viem'
import vector from '../vectors/blobmail-v0.json' with { type: 'json' }
import { loadNodeKzg } from '../src/sidecars/index.js'
import { createSegmentPublicationPackage } from '../src/publication/index.js'
import { BLOBMAIL_CONTENT_TAG, BSS_ABI, decodeBlobMailSegment } from '../src/segments/index.js'
import { parseBatch } from '../src/protocol/index.js'

function hexToBytes(value) {
  return Uint8Array.from(value.match(/../gu), (byte) => Number.parseInt(byte, 16))
}

test('segment publication package binds encrypted entries to KZG, FE range, and BSS calldata', async () => {
  const kzg = await loadNodeKzg()
  const entry = hexToBytes(vector.encryption.entryHex)
  const result = await createSegmentPublicationPackage({ entries: [entry], startFE: 3000, kzg })

  assert.equal(result.schema, 'blobmail.segment-publication-package.v1')
  assert.equal(result.manifest.startFE, 3000)
  assert.equal(result.manifest.endFE, 3022)
  assert.equal(result.manifest.contentTag, BLOBMAIL_CONTENT_TAG)
  assert.equal(result.sidecar.kzgProofVerified, true)
  assert.deepEqual(decodeBlobMailSegment(result.blob, result.manifest), result.batch.bytes)
  assert.equal((await parseBatch(result.batch.bytes)).batchId, result.batch.batchId)

  const declaration = decodeFunctionData({ abi: BSS_ABI, data: result.transaction.data })
  assert.deepEqual(declaration.args, [0n, 3000, 3022, BLOBMAIL_CONTENT_TAG])
})

test('segment publication package rejects malformed entries and missing KZG', async () => {
  const entry = hexToBytes(vector.encryption.entryHex)
  await assert.rejects(createSegmentPublicationPackage({ entries: [entry] }), /KZG/u)
  const kzg = await loadNodeKzg()
  entry[0] ^= 1
  await assert.rejects(createSegmentPublicationPackage({ entries: [entry], kzg }), /magic/u)
})
