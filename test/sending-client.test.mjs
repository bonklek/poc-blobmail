import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveIdentity } from '../src/protocol/index.js'
import { createContactCode } from '../src/identity/index.js'
import { createBatcherClient, sendBlobMailMessage } from '../src/sending/index.js'
import { hexToBytes } from '../src/transport/index.js'
import { verifyEntry } from '../src/protocol/index.js'

function job(entryId, status, extra = {}) {
  return { schema: 'blobmail.batcher-job.v1', id: entryId, entryId, status, ...extra }
}

test('sender resolves a raw contact, encrypts locally, and waits for inclusion', async () => {
  const recipientIdentity = await deriveIdentity(new Uint8Array(32).fill(21))
  const contact = await createContactCode(recipientIdentity.publicKeyBytes)
  let entryId
  let polls = 0
  const result = await sendBlobMailMessage({
    recipient: contact,
    text: 'sender integration test',
    pollIntervalMs: 0,
    batcher: {
      submit: async (entryHex) => {
        const entry = await verifyEntry(hexToBytes(entryHex))
        entryId = entry.entryId
        return job(entryId, 'queued')
      },
      get: async () => {
        polls += 1
        return polls === 1 ? job(entryId, 'submitted') : job(entryId, 'included', {
          transactionHash: `0x${'55'.repeat(32)}`,
          batchId: '66'.repeat(32),
        })
      },
    },
  })
  assert.equal(result.status, 'included')
  assert.equal(result.recipient.source, 'contact-code')
  assert.equal(polls, 2)
})

test('sender uses the same resolver path for .eth and .gwei records', async () => {
  const recipientIdentity = await deriveIdentity(new Uint8Array(32).fill(22))
  const contact = await createContactCode(recipientIdentity.publicKeyBytes)
  for (const [recipient, key] of [['alice.eth', 'readEnsText'], ['alice.gwei', 'readGweiText']]) {
    const options = {
      recipient,
      text: 'named recipient',
      pollIntervalMs: 0,
      batcher: {
        submit: async (entryHex) => {
          const entry = await verifyEntry(hexToBytes(entryHex))
          return job(entry.entryId, 'included', { transactionHash: `0x${'77'.repeat(32)}`, batchId: '88'.repeat(32) })
        },
        get: async () => { throw new Error('must not poll') },
      },
      [key]: async (name) => ({
        value: contact,
        normalizedName: name,
        chainId: 1n,
        blockNumber: 1n,
        resolverAddress: `0x${'99'.repeat(20)}`,
      }),
    }
    const result = await sendBlobMailMessage(options)
    assert.equal(result.recipient.name, recipient)
  }
})

test('HTTP batcher client accepts HTTPS and loopback HTTP but rejects unsafe origins', () => {
  assert.equal(createBatcherClient({ endpoint: 'https://batcher.example.org' }).endpoint, 'https://batcher.example.org')
  assert.equal(createBatcherClient({ endpoint: 'http://127.0.0.1:8787' }).endpoint, 'http://127.0.0.1:8787')
  assert.throws(() => createBatcherClient({ endpoint: 'http://batcher.example.org' }), /HTTPS origin/u)
  assert.throws(() => createBatcherClient({ endpoint: 'https://user:pass@batcher.example.org' }), /HTTPS origin/u)
})
