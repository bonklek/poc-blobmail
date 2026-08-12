import { request } from 'node:https'

export class BoundedRequestError extends Error {
  constructor(code) {
    super(code)
    this.name = 'BoundedRequestError'
    this.code = code
  }
}

export function boundedHttpsJson(spec) {
  if (!spec || !(spec.url instanceof URL) || spec.url.protocol !== 'https:') {
    throw new BoundedRequestError('INVALID_REQUEST_TARGET')
  }
  if (!['GET', 'POST'].includes(spec.method)) throw new BoundedRequestError('METHOD_NOT_ALLOWED')
  if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 15_000) {
    throw new BoundedRequestError('INVALID_TIMEOUT_LIMIT')
  }
  if (!Number.isInteger(spec.maxResponseBytes) || spec.maxResponseBytes < 1 || spec.maxResponseBytes > 8_388_608) {
    throw new BoundedRequestError('INVALID_RESPONSE_LIMIT')
  }

  const serializedBody = spec.body === null ? null : JSON.stringify(spec.body)
  if (serializedBody && Buffer.byteLength(serializedBody) > 4_096) {
    throw new BoundedRequestError('REQUEST_BODY_TOO_LARGE')
  }

  return new Promise((resolve, reject) => {
    let settled = false
    const finishReject = (code) => {
      if (settled) return
      settled = true
      reject(new BoundedRequestError(code))
    }

    const headers = {
      ...spec.headers,
      'accept-encoding': 'identity',
      'user-agent': 'BlobMail-Sepolia-ReadOnly/0',
    }
    if (serializedBody !== null) headers['content-length'] = String(Buffer.byteLength(serializedBody))

    const outgoing = request(spec.url, {
      method: spec.method,
      headers,
      agent: false,
      timeout: spec.timeoutMs,
    }, (incoming) => {
      const advertised = Number(incoming.headers['content-length'])
      if (Number.isFinite(advertised) && advertised > spec.maxResponseBytes) {
        incoming.destroy()
        finishReject('RESPONSE_TOO_LARGE')
        return
      }

      const chunks = []
      let bytes = 0
      incoming.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > spec.maxResponseBytes) {
          incoming.destroy()
          finishReject('RESPONSE_TOO_LARGE')
          return
        }
        chunks.push(chunk)
      })
      incoming.on('error', () => finishReject('RESPONSE_STREAM_FAILED'))
      incoming.on('end', () => {
        if (settled) return
        let body
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          finishReject('INVALID_JSON_RESPONSE')
          return
        }
        settled = true
        resolve({ statusCode: incoming.statusCode, body, responseBytes: bytes })
      })
    })

    outgoing.on('timeout', () => outgoing.destroy(new BoundedRequestError('REQUEST_TIMEOUT')))
    outgoing.on('error', (error) => finishReject(error instanceof BoundedRequestError ? error.code : 'REQUEST_FAILED'))
    if (serializedBody !== null) outgoing.write(serializedBody)
    outgoing.end()
  })
}
