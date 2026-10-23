import assert from 'node:assert/strict'
import test from 'node:test'

import vector from '../vectors/blobmail-v0.json' with { type: 'json' }
import { createReferenceBatcher } from '../src/batcher/index.js'

const entryHex = `0x${vector.encryption.entryHex}`

test('reference batcher deduplicates canonical entries and exposes bounded public status', async () => {
  let calls = 0
  const batcher = createReferenceBatcher({
    now: () => '2026-08-12T12:00:00.000Z',
    publish: async () => {
      calls += 1
      return {
        status: 'included',
        transactionHash: `0x${'11'.repeat(32)}`,
        batchId: '22'.repeat(32),
        manifest: { schema: 'blobmail.segment-manifest.v1' },
      }
    },
  })
  const first = await batcher.submit({ entryHex, expiresAt: '2026-08-13T00:00:00.000Z' })
  const duplicate = await batcher.submit({ entryHex })
  assert.equal(first.id, vector.encryption.entryId)
  assert.equal(duplicate.id, first.id)
  await batcher.waitForIdle()
  const completed = batcher.get(first.id)
  assert.equal(completed.status, 'included')
  assert.equal(completed.transactionHash, `0x${'11'.repeat(32)}`)
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(completed).includes('entryHex'), false)
})

test('reference batcher fails closed for malformed, expired, unknown, and failed jobs', async () => {
  const batcher = createReferenceBatcher({
    now: () => '2026-08-12T12:00:00.000Z',
    publish: async () => { throw Object.assign(new Error('no'), { code: 'RPC_FAILED' }) },
  })
  await assert.rejects(batcher.submit({ entryHex: '0x1234' }), (error) => error.code === 'INVALID_ENTRY')
  await assert.rejects(
    batcher.submit({ entryHex, expiresAt: '2026-08-12T11:59:59.000Z' }),
    (error) => error.code === 'EXPIRED',
  )
  await assert.rejects(Promise.resolve().then(() => batcher.get('missing')), (error) => error.code === 'NOT_FOUND')
  const accepted = await batcher.submit({ entryHex })
  await batcher.waitForIdle()
  assert.equal(batcher.get(accepted.id).status, 'failed')
  assert.equal(batcher.get(accepted.id).errorCode, 'RPC_FAILED')
})

test('reference batcher re-checks expiresAt before publication and never publishes an expired entry', async () => {
  // Admission sees 11:59:59 (not yet expired); the publication-time check sees 12:00:01.
  const clock = ['2026-08-12T11:59:59.000Z']
  let calls = 0
  const batcher = createReferenceBatcher({
    now: () => clock[0],
    publish: async () => {
      calls += 1
      return { status: 'packaged', batchId: '22'.repeat(32) }
    },
  })
  const submission = batcher.submit({ entryHex, expiresAt: '2026-08-12T12:00:00.000Z' })
  clock[0] = '2026-08-12T12:00:01.000Z'
  const accepted = await submission
  await batcher.waitForIdle()
  const job = batcher.get(accepted.id)
  assert.equal(job.status, 'failed')
  assert.equal(job.errorCode, 'EXPIRED')
  assert.equal(calls, 0)
})
