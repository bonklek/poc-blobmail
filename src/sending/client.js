import { encryptText } from '../protocol/index.js'
import { resolveRecipient } from '../identity/index.js'
import { bytesToHex } from '../transport/index.js'

export const SEND_LIMITS = Object.freeze({
  maxPolls: 60,
  pollIntervalMs: 2_000,
  maxResponseBytes: 16_384,
  requestTimeoutMs: 10_000,
})

export class SendClientError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'SendClientError'
    this.code = code
    this.cause = cause
  }
}

function fail(code, message, cause) {
  throw new SendClientError(code, message, cause)
}

function normalizeJob(value) {
  if (!value || value.schema !== 'blobmail.batcher-job.v1'
    || typeof value.id !== 'string' || value.id !== value.entryId
    || !['queued', 'publishing', 'packaged', 'submitted', 'included', 'failed'].includes(value.status)) {
    fail('INVALID_BATCHER_RESPONSE', 'batcher returned an invalid job')
  }
  if (!/^[0-9a-f]{64}$/u.test(value.entryId)) fail('INVALID_BATCHER_RESPONSE', 'batcher returned an invalid entry ID')
  return value
}

export function createBatcherClient({
  endpoint,
  fetchImpl = globalThis.fetch,
  timeoutMs = SEND_LIMITS.requestTimeoutMs,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('timeoutMs must be between 1 and 60000')
  }
  let origin
  try {
    const url = new URL(endpoint)
    const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new Error('unsafe')
    }
    origin = url.origin
  } catch {
    throw new TypeError('batcher endpoint must be an HTTPS origin or loopback HTTP origin')
  }

  async function json(pathname, options = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let response
    let text
    try {
      try {
        response = await fetchImpl(new URL(pathname, `${origin}/`), {
          ...options,
          signal: controller.signal,
          redirect: 'error',
          cache: 'no-store',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        })
      } catch (cause) {
        fail('BATCHER_UNAVAILABLE', 'batcher request failed', cause)
      }
      const advertised = Number(response.headers?.get?.('content-length'))
      if (Number.isFinite(advertised) && advertised > SEND_LIMITS.maxResponseBytes) {
        controller.abort()
        fail('BATCHER_RESPONSE_TOO_LARGE', 'batcher response exceeds its byte bound')
      }
      try {
        text = await response.text()
      } catch (cause) {
        fail('BATCHER_UNAVAILABLE', 'batcher response could not be read', cause)
      }
    } finally {
      clearTimeout(timeout)
    }
    if (new TextEncoder().encode(text).byteLength > SEND_LIMITS.maxResponseBytes) {
      fail('BATCHER_RESPONSE_TOO_LARGE', 'batcher response exceeds its byte bound')
    }
    let body
    try { body = JSON.parse(text) } catch { fail('INVALID_BATCHER_RESPONSE', 'batcher response is not JSON') }
    if (!response.ok) fail(String(body?.error ?? 'BATCHER_REJECTED'), `batcher rejected the request with HTTP ${response.status}`)
    return body
  }

  return Object.freeze({
    endpoint: origin,
    submit: (entryHex) => json('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entryHex }),
    }).then(normalizeJob),
    get: (id) => {
      if (!/^[0-9a-f]{64}$/u.test(String(id ?? ''))) throw new TypeError('job ID must be lowercase 32-byte hex')
      return json(`/v1/messages/${id}`, { method: 'GET' }).then(normalizeJob)
    },
  })
}

export async function sendBlobMailMessage({
  recipient,
  text,
  readEnsText,
  readGweiText,
  batcher,
  maxPolls = SEND_LIMITS.maxPolls,
  pollIntervalMs = SEND_LIMITS.pollIntervalMs,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!batcher || typeof batcher.submit !== 'function' || typeof batcher.get !== 'function') {
    fail('INVALID_BATCHER', 'a batcher client is required')
  }
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > SEND_LIMITS.maxPolls) {
    throw new RangeError(`maxPolls must be between 1 and ${SEND_LIMITS.maxPolls}`)
  }
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || pollIntervalMs > 10_000) {
    throw new RangeError('pollIntervalMs must be between 0 and 10000')
  }
  const resolved = await resolveRecipient(recipient, { readEnsText, readGweiText })
  const encrypted = await encryptText({ text, recipientPublicKeyBytes: resolved.publicKeyBytes })
  let job = normalizeJob(await batcher.submit(bytesToHex(encrypted.entryBytes)))
  if (job.entryId !== encrypted.entryId) fail('BATCHER_ENTRY_MISMATCH', 'batcher job does not match the encrypted entry')
  if (job.status === 'packaged') fail('BATCHER_OFFLINE', 'batcher packaged the entry but is not configured for Sepolia publication')
  for (let poll = 0; !['included', 'failed'].includes(job.status) && poll < maxPolls; poll += 1) {
    if (pollIntervalMs > 0) await wait(pollIntervalMs)
    job = normalizeJob(await batcher.get(job.id))
    if (job.entryId !== encrypted.entryId) fail('BATCHER_ENTRY_MISMATCH', 'batcher status changed entry identity')
    if (job.status === 'packaged') fail('BATCHER_OFFLINE', 'batcher packaged the entry but is not configured for Sepolia publication')
  }
  if (job.status === 'failed') fail(job.errorCode ?? 'PUBLICATION_FAILED', 'batcher failed to publish the encrypted entry')
  if (job.status !== 'included') fail('PUBLICATION_TIMEOUT', 'batcher did not confirm inclusion within the polling bound')
  if (!/^0x[0-9a-f]{64}$/u.test(String(job.transactionHash ?? '')) || !/^[0-9a-f]{64}$/u.test(String(job.batchId ?? ''))) {
    fail('INVALID_BATCHER_RESPONSE', 'included job omitted its transaction or batch identifier')
  }
  return Object.freeze({
    entryId: encrypted.entryId,
    batchId: job.batchId,
    transactionHash: job.transactionHash,
    recipient: resolved,
    status: job.status,
  })
}
