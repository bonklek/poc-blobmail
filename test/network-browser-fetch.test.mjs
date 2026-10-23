import assert from 'node:assert/strict'
import test from 'node:test'

import { boundedFetchJson } from '../src/network/browser-fetch.js'

const spec = (overrides = {}) => ({
  url: new URL('https://provider.example/'),
  method: 'GET',
  headers: { accept: 'application/json' },
  body: null,
  timeoutMs: 50,
  maxResponseBytes: 1024,
  ...overrides,
})

function stalledBodyFetch() {
  return async (_url, { signal }) => ({
    status: 200,
    headers: new Headers(),
    arrayBuffer: () => new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })
}

test('browser fetch timeout also bounds a stalled response body', async () => {
  const started = Date.now()
  await assert.rejects(boundedFetchJson(spec(), stalledBodyFetch()), { code: 'REQUEST_FAILED' })
  assert.ok(Date.now() - started < 2_000)
})

test('browser fetch maps body read failures to a bounded error code', async () => {
  const fetchImpl = async () => ({
    status: 200,
    headers: new Headers(),
    arrayBuffer: async () => { throw new TypeError('network reset') },
  })
  await assert.rejects(boundedFetchJson(spec(), fetchImpl), { name: 'BrowserRequestError', code: 'REQUEST_FAILED' })
})

test('browser fetch still parses a bounded JSON response', async () => {
  const fetchImpl = async () => new Response('{"ok":true}', { status: 200 })
  assert.deepEqual(await boundedFetchJson(spec(), fetchImpl), { statusCode: 200, body: { ok: true }, responseBytes: 11 })
})
