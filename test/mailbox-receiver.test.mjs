import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveIdentity, encryptText, packBatch } from '../src/protocol/index.js'
import { refreshMailbox } from '../src/mailbox/index.js'

const TX = `0x${'11'.repeat(32)}`
const BLOCK = `0x${'22'.repeat(32)}`
const VERSIONED = `0x01${'33'.repeat(31)}`

test('mailbox refresh scans verified batches, deduplicates entries, and advances atomically', async () => {
  const recipient = await deriveIdentity(new Uint8Array(32).fill(8))
  const other = await deriveIdentity(new Uint8Array(32).fill(9))
  const wanted = await encryptText({ text: 'hello from a segment', recipientIdentity: recipient, ephemeralSeed: new Uint8Array(32).fill(10) })
  const unrelated = await encryptText({ text: 'not ours', recipientIdentity: other, ephemeralSeed: new Uint8Array(32).fill(11) })
  const batch = await packBatch([wanted.entryBytes, unrelated.entryBytes])
  const declaration = {
    transactionHash: TX,
    blockHash: BLOCK,
    blockNumber: 50,
    logIndex: 0,
    versionedHash: VERSIONED,
    startFE: 4,
    endFE: 30,
  }
  const discover = async () => ({
    declarations: [declaration],
    nextBlock: 51,
    anchor: { blockNumber: 50, blockHash: BLOCK },
    headBlock: 52,
    safeHead: 50,
    scanned: { fromBlock: 50, toBlock: 50 },
  })
  const replay = async ({ manifest, txHash }) => {
    assert.equal(txHash, TX)
    assert.deepEqual(manifest, { blobVersionedHashes: [VERSIONED], startFE: 4, endFE: 30 })
    return { batchId: batch.batchId, payload: batch.batchBytes, evidence: [{ state: 'KZG_PROOF_VERIFIED' }] }
  }

  const first = await refreshMailbox({
    identity: recipient,
    fromBlock: 50,
    existingEntryIds: [],
    discover,
    replay,
    now: () => '2026-08-12T00:00:00.000Z',
  })
  assert.equal(first.messages.length, 1)
  assert.equal(first.messages[0].body, 'hello from a segment')
  assert.equal(first.batches[0].notForRecipient, 1)
  assert.deepEqual(first.cursor, { nextBlock: 51, anchor: { blockNumber: 50, blockHash: BLOCK } })

  const second = await refreshMailbox({
    identity: recipient,
    fromBlock: 50,
    existingEntryIds: [wanted.entryId],
    discover,
    replay,
  })
  assert.equal(second.messages.length, 0)
})

test('mailbox cursor does not escape when a discovered sidecar fails verification', async () => {
  const recipient = await deriveIdentity(new Uint8Array(32).fill(12))
  await assert.rejects(() => refreshMailbox({
    identity: recipient,
    fromBlock: 10,
    discover: async () => ({
      declarations: [{ transactionHash: TX, versionedHash: VERSIONED, startFE: 0, endFE: 22 }],
      nextBlock: 11,
      anchor: { blockNumber: 10, blockHash: BLOCK },
    }),
    replay: async () => { throw Object.assign(new Error('bad proof'), { code: 'INVALID_KZG_PROOF' }) },
  }), { code: 'INVALID_KZG_PROOF' })
})
