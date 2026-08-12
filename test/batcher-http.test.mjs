import assert from 'node:assert/strict'
import test from 'node:test'

import vector from '../vectors/blobmail-v0.json' with { type: 'json' }
import { createBatcherHttpServer, createReferenceBatcher } from '../src/batcher/index.js'

async function withServer(run) {
  const batcher = createReferenceBatcher({
    publish: async () => ({ status: 'packaged', batchId: '11'.repeat(32), manifest: { schema: 'blobmail.segment-manifest.v1' } }),
  })
  const server = createBatcherHttpServer({ batcher })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    await run(`http://127.0.0.1:${port}`, batcher)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('HTTP batcher accepts canonical encrypted entries and exposes status without ciphertext', async () => {
  await withServer(async (origin, batcher) => {
    const response = await fetch(`${origin}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ entryHex: `0x${vector.encryption.entryHex}` }),
    })
    assert.equal(response.status, 202)
    const accepted = await response.json()
    await batcher.waitForIdle()
    const status = await (await fetch(`${origin}/v1/messages/${accepted.id}`)).json()
    assert.equal(status.status, 'packaged')
    assert.equal(JSON.stringify(status).includes(vector.encryption.entryHex), false)
  })
})

test('HTTP batcher rejects foreign origins, invalid media, oversized bodies, and unknown paths', async () => {
  await withServer(async (origin) => {
    assert.equal((await fetch(`${origin}/health`, { headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal((await fetch(`${origin}/v1/messages`, { method: 'POST', body: '{}' })).status, 415)
    assert.equal((await fetch(`${origin}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'x'.repeat(5000) }),
    })).status, 413)
    assert.equal((await fetch(`${origin}/missing`)).status, 404)
  })
})
