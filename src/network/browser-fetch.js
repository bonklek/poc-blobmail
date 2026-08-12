export class BrowserRequestError extends Error {
  constructor(code) {
    super(code)
    this.name = 'BrowserRequestError'
    this.code = code
  }
}

export async function boundedFetchJson(spec, fetchImpl = globalThis.fetch) {
  if (!spec || !(spec.url instanceof URL) || spec.url.protocol !== 'https:') throw new BrowserRequestError('INVALID_REQUEST_TARGET')
  if (!['GET', 'POST'].includes(spec.method)) throw new BrowserRequestError('METHOD_NOT_ALLOWED')
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 15_000) throw new BrowserRequestError('INVALID_TIMEOUT')
  if (!Number.isSafeInteger(spec.maxResponseBytes) || spec.maxResponseBytes < 1 || spec.maxResponseBytes > 8_388_608) {
    throw new BrowserRequestError('INVALID_RESPONSE_LIMIT')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), spec.timeoutMs)
  let response
  try {
    response = await fetchImpl(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body === null ? undefined : JSON.stringify(spec.body),
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
  } catch {
    throw new BrowserRequestError('REQUEST_FAILED')
  } finally {
    clearTimeout(timeout)
  }
  const advertised = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(advertised) && advertised > spec.maxResponseBytes) throw new BrowserRequestError('RESPONSE_TOO_LARGE')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > spec.maxResponseBytes) throw new BrowserRequestError('RESPONSE_TOO_LARGE')
  let body
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new BrowserRequestError('INVALID_JSON_RESPONSE') }
  return { statusCode: response.status, body, responseBytes: bytes.byteLength }
}

export function createBrowserRpc(origin, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000,
  maxResponseBytes = 1_048_576,
} = {}) {
  let url
  try {
    url = new URL(origin)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) throw new Error('unsafe')
  } catch {
    throw new TypeError('RPC endpoint must be an HTTPS root origin without credentials')
  }
  let id = 0
  const requestEnvelope = async ({ method, params = [] }) => {
    id += 1
    const requestId = id
    const response = await boundedFetchJson({
      url,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: { jsonrpc: '2.0', id: requestId, method, params },
      timeoutMs,
      maxResponseBytes,
    }, fetchImpl)
    if (response.statusCode !== 200 || response.body?.jsonrpc !== '2.0' || response.body?.id !== requestId
      || response.body.error || !Object.hasOwn(response.body ?? {}, 'result')) {
      throw new BrowserRequestError('INVALID_RPC_RESPONSE')
    }
    return response.body.result
  }
  return Object.freeze({
    request: requestEnvelope,
    requestRpc: (method, params = []) => requestEnvelope({ method, params }),
  })
}
