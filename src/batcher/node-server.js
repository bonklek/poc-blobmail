import { createServer } from 'node:http'

import { BatcherServiceError } from './service.js'

const JOB_PATH = /^\/v1\/messages\/([0-9a-f]{64})$/u

function send(response, status, body, origin) {
  const bytes = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.byteLength),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {}),
  })
  response.end(bytes)
}

async function readJson(request, maxBytes) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new BatcherServiceError('UNSUPPORTED_MEDIA_TYPE', 'content-type must be application/json', 415)
  }
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.byteLength
    if (total > maxBytes) throw new BatcherServiceError('REQUEST_TOO_LARGE', 'request exceeds its byte bound', 413)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new BatcherServiceError('INVALID_JSON', 'request body must be valid JSON')
  }
}

export function createBatcherHttpServer({
  batcher,
  allowedOrigin = 'http://127.0.0.1:5173',
  maxRequestBytes = 4096,
} = {}) {
  if (!batcher || typeof batcher.submit !== 'function' || typeof batcher.get !== 'function') {
    throw new TypeError('a reference batcher service is required')
  }
  if (typeof allowedOrigin !== 'string' || !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u.test(allowedOrigin)) {
    throw new TypeError('allowedOrigin must be an explicit loopback HTTP origin')
  }
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1024 || maxRequestBytes > 16_384) {
    throw new RangeError('maxRequestBytes must be between 1024 and 16384')
  }

  return createServer(async (request, response) => {
    const origin = request.headers.origin
    const corsOrigin = origin === allowedOrigin ? allowedOrigin : null
    if (origin && !corsOrigin) {
      send(response, 403, { error: 'ORIGIN_NOT_ALLOWED' })
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': corsOrigin ?? allowedOrigin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'content-type',
        'access-control-max-age': '600',
        vary: 'origin',
      })
      response.end()
      return
    }
    try {
      if (request.method === 'GET' && request.url === '/health') {
        send(response, 200, { schema: 'blobmail.batcher-health.v1', status: 'ok' }, corsOrigin)
        return
      }
      if (request.method === 'POST' && request.url === '/v1/messages') {
        send(response, 202, await batcher.submit(await readJson(request, maxRequestBytes)), corsOrigin)
        return
      }
      const job = request.method === 'GET' ? JOB_PATH.exec(request.url ?? '') : null
      if (job) {
        send(response, 200, batcher.get(job[1]), corsOrigin)
        return
      }
      send(response, 404, { error: 'NOT_FOUND' }, corsOrigin)
    } catch (error) {
      const status = error instanceof BatcherServiceError ? error.status : 500
      const code = error instanceof BatcherServiceError ? error.code : 'INTERNAL_ERROR'
      send(response, status, { error: code }, corsOrigin)
    }
  })
}

const LISTEN_ERROR_CODES = Object.freeze({ EADDRINUSE: 'PORT_IN_USE', EACCES: 'PORT_ACCESS_DENIED' })

// Resolve once the server is listening; reject with a stable code instead of letting
// an unhandled 'error' event (for example EADDRINUSE) crash the process.
export function listenBatcherServer(server, { port, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      const code = LISTEN_ERROR_CODES[error?.code] ?? 'LISTEN_FAILED'
      const reason = code === 'PORT_IN_USE' ? 'the port is already in use' : (error?.code ?? 'unknown error')
      reject(Object.assign(
        new Error(`reference batcher could not listen on http://${host}:${port}: ${reason}`),
        { code, cause: error },
      ))
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address())
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}
