import {
  NetworkProfileError,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_GENESIS,
  providerRequestUrl,
} from './profile.js'

const ZERO_TRANSACTION_HASH = `0x${'00'.repeat(32)}`
const ZERO_VERSIONED_HASH = `0x${'00'.repeat(32)}`
const EXECUTION_METHODS = Object.freeze([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getTransactionByHash',
])

export class ProviderProbeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProviderProbeError'
    this.code = code
  }
}

function fail(code, message) {
  throw new ProviderProbeError(code, message)
}

function assertReadonlyProfile(profile) {
  if (!profile || profile.schema !== 'blobmail.network-profile.v0') {
    fail('INVALID_NETWORK_PROFILE', 'a BlobMail network profile is required')
  }
  if (profile.mode !== 'readonly' || !profile.providers) {
    fail('NETWORK_DISABLED', 'provider probes require explicit readonly mode')
  }
  if (profile.network !== 'sepolia' || profile.chain.id !== SEPOLIA_CHAIN_ID) {
    fail('UNSUPPORTED_NETWORK', 'only the pinned Sepolia profile can be probed')
  }
}

function parseHexQuantity(value, name) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    fail('INVALID_PROVIDER_RESPONSE', `${name} is not a canonical hex quantity`)
  }
  const parsed = BigInt(value)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('INVALID_PROVIDER_RESPONSE', `${name} exceeds the safe reporting range`)
  }
  return Number(parsed)
}

function isHexQuantity(value) {
  return typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)
}

function assertHex(value, bytes, name) {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`, 'i').test(value)) {
    fail('INVALID_PROVIDER_RESPONSE', `${name} must be ${bytes} bytes of hex`)
  }
  return value.toLowerCase()
}

function rpcBody(id, method, params = []) {
  if (!EXECUTION_METHODS.includes(method)) fail('METHOD_NOT_ALLOWED', `execution method ${method} is not read-only allowlisted`)
  return { jsonrpc: '2.0', id, method, params }
}

function unwrapRpc(response, method, expectedId) {
  if (!response || response.statusCode !== 200 || !response.body || typeof response.body !== 'object') {
    fail('PROVIDER_HTTP_ERROR', `${method} did not return HTTP 200 JSON`)
  }
  if (response.body.jsonrpc !== '2.0' || response.body.id !== expectedId) {
    fail('INVALID_PROVIDER_RESPONSE', `${method} returned a mismatched JSON-RPC envelope`)
  }
  if (response.body.error) fail('PROVIDER_RPC_ERROR', `${method} returned a JSON-RPC error`)
  if (!Object.hasOwn(response.body, 'result')) fail('INVALID_PROVIDER_RESPONSE', `${method} omitted result`)
  return response.body.result
}

function unwrapBeacon(response, endpoint) {
  if (!response || response.statusCode !== 200 || !response.body || typeof response.body !== 'object') {
    fail('PROVIDER_HTTP_ERROR', `${endpoint} did not return HTTP 200 JSON`)
  }
  if (!response.body.data || typeof response.body.data !== 'object') {
    fail('INVALID_PROVIDER_RESPONSE', `${endpoint} omitted data`)
  }
  return response.body.data
}

function errorDiagnostic(error) {
  const allowed = error instanceof ProviderProbeError || error instanceof NetworkProfileError
  return Object.freeze({
    code: allowed && typeof error.code === 'string' ? error.code : 'PROVIDER_REQUEST_FAILED',
    category: allowed ? error.name : 'ProviderRequestError',
  })
}

function endpointBehavior(response) {
  if (!response || !Number.isInteger(response.statusCode)) {
    fail('INVALID_PROVIDER_RESPONSE', 'endpoint behavior probe omitted an HTTP status')
  }
  const body = response.body
  const count = body && Array.isArray(body.data) ? body.data.length : null
  let outcome = 'provider_error'
  if (response.statusCode === 200) outcome = count === 0 ? 'available_empty' : 'available_data'
  else if (response.statusCode === 400) outcome = 'available_rejected_sentinel'
  else if (response.statusCode === 404 || response.statusCode === 410 || response.statusCode === 501) outcome = 'unsupported'
  return Object.freeze({ statusCode: response.statusCode, outcome, itemCount: count })
}

function requestSpec(profile, role, pathname, method, body) {
  const provider = profile.providers[role]
  return Object.freeze({
    role,
    providerId: provider.providerId,
    url: providerRequestUrl(provider, pathname),
    method,
    headers: method === 'POST'
      ? Object.freeze({ accept: 'application/json', 'content-type': 'application/json' })
      : Object.freeze({ accept: 'application/json' }),
    body: body ?? null,
    timeoutMs: profile.limits.timeoutMs,
    maxResponseBytes: role === 'execution'
      ? profile.limits.executionResponseBytes
      : profile.limits.beaconResponseBytes,
  })
}

async function requestExecution(profile, requestJson, id, method, params = []) {
  return requestJson(requestSpec(profile, 'execution', '/', 'POST', rpcBody(id, method, params)))
}

async function requestBeacon(profile, requestJson, pathname) {
  return requestJson(requestSpec(profile, 'beacon', pathname, 'GET'))
}

async function executionIdentity(profile, requestJson) {
  const result = unwrapRpc(await requestExecution(profile, requestJson, 1, 'eth_chainId'), 'eth_chainId', 1)
  const chainId = parseHexQuantity(result, 'chainId')
  if (chainId !== profile.chain.id) {
    fail('CHAIN_ID_MISMATCH', `execution provider returned chain ID ${chainId}`)
  }
  return Object.freeze({ chainId })
}

async function beaconIdentity(profile, requestJson) {
  const data = unwrapBeacon(
    await requestBeacon(profile, requestJson, '/eth/v1/beacon/genesis'),
    'beacon genesis',
  )
  const observed = Object.freeze({
    time: String(data.genesis_time),
    forkVersion: assertHex(data.genesis_fork_version, 4, 'genesis_fork_version'),
    validatorsRoot: assertHex(data.genesis_validators_root, 32, 'genesis_validators_root'),
  })
  if (
    observed.time !== profile.chain.genesis.time
    || observed.forkVersion !== profile.chain.genesis.forkVersion
    || observed.validatorsRoot !== profile.chain.genesis.validatorsRoot
  ) {
    fail('BEACON_GENESIS_MISMATCH', 'beacon provider returned a different genesis identity')
  }
  return observed
}

function parseHeaderSlot(data, name) {
  const slot = data?.header?.message?.slot
  if (typeof slot !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(slot)) {
    fail('INVALID_PROVIDER_RESPONSE', `${name} header omitted a canonical slot`)
  }
  const parsed = BigInt(slot)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_PROVIDER_RESPONSE', `${name} slot is too large`)
  return Number(parsed)
}

async function probeExecutionCapabilities(profile, requestJson) {
  const blockNumber = parseHexQuantity(
    unwrapRpc(await requestExecution(profile, requestJson, 2, 'eth_blockNumber'), 'eth_blockNumber', 2),
    'blockNumber',
  )
  const block = unwrapRpc(
    await requestExecution(profile, requestJson, 3, 'eth_getBlockByNumber', ['latest', true]),
    'eth_getBlockByNumber',
    3,
  )
  if (!block || typeof block !== 'object') fail('INVALID_PROVIDER_RESPONSE', 'latest block is not an object')
  if (!Array.isArray(block.transactions) || block.transactions.some((transaction) => !transaction || typeof transaction !== 'object')) {
    fail('INVALID_PROVIDER_RESPONSE', 'latest block omitted full transaction objects')
  }
  const observedBlockNumber = parseHexQuantity(block.number, 'latestBlock.number')
  const blockHash = assertHex(block.hash, 32, 'latestBlock.hash')
  const sentinelTransaction = unwrapRpc(
    await requestExecution(profile, requestJson, 4, 'eth_getTransactionByHash', [ZERO_TRANSACTION_HASH]),
    'eth_getTransactionByHash',
    4,
  )
  if (sentinelTransaction !== null) {
    fail('INVALID_PROVIDER_RESPONSE', 'zero transaction sentinel unexpectedly resolved')
  }

  const blobHeaderFields = Object.freeze({
    blobGasUsed: isHexQuantity(block.blobGasUsed),
    excessBlobGas: isHexQuantity(block.excessBlobGas),
    parentBeaconBlockRoot: typeof block.parentBeaconBlockRoot === 'string'
      && /^0x[0-9a-f]{64}$/i.test(block.parentBeaconBlockRoot),
  })
  const blobTransactionsObserved = block.transactions.filter((transaction) => (
    (isHexQuantity(transaction.type) && BigInt(transaction.type) === 3n)
    || (
      Array.isArray(transaction.blobVersionedHashes)
      && transaction.blobVersionedHashes.length > 0
      && transaction.blobVersionedHashes.every((hash) => typeof hash === 'string' && /^0x[0-9a-f]{64}$/i.test(hash))
    )
  )).length
  return Object.freeze({
    blockNumber,
    latestBlock: Object.freeze({ number: observedBlockNumber, hash: blockHash }),
    blockLagAtProbe: Math.max(0, blockNumber - observedBlockNumber),
    blobAwareBlockRead: blobHeaderFields.blobGasUsed
      && blobHeaderFields.excessBlobGas
      && blobHeaderFields.parentBeaconBlockRoot,
    blobHeaderFields,
    fullTransactionObjectsRead: block.transactions.length,
    blobTransactionsObserved,
    blobTransactionRead: blobTransactionsObserved > 0
      ? 'observed_in_latest_block'
      : 'supported_not_observed_in_latest_block',
    transactionReadMethod: 'supported_null_sentinel',
  })
}

async function probeBeaconCapabilities(profile, requestJson) {
  const [headResponse, finalizedResponse] = await Promise.all([
    requestBeacon(profile, requestJson, '/eth/v1/beacon/headers/head'),
    requestBeacon(profile, requestJson, '/eth/v1/beacon/headers/finalized'),
  ])
  const headSlot = parseHeaderSlot(unwrapBeacon(headResponse, 'head header'), 'head')
  const finalizedSlot = parseHeaderSlot(unwrapBeacon(finalizedResponse, 'finalized header'), 'finalized')
  if (finalizedSlot > headSlot) fail('INVALID_PROVIDER_RESPONSE', 'finalized slot exceeds head slot')

  const [legacySidecars, currentBlobs] = await Promise.all([
    requestBeacon(profile, requestJson, '/eth/v1/beacon/blob_sidecars/head?indices=0'),
    requestBeacon(profile, requestJson, `/eth/v1/beacon/blobs/head?versioned_hashes=${ZERO_VERSIONED_HASH}`),
  ])

  return Object.freeze({
    headSlot,
    finalizedSlot,
    finalityDistanceSlots: headSlot - finalizedSlot,
    legacySidecars: endpointBehavior(legacySidecars),
    currentBlobs: endpointBehavior(currentBlobs),
  })
}

function baseProviderReport(provider) {
  return {
    providerId: provider.providerId,
    hostname: provider.hostname,
    result: 'PENDING',
    identity: null,
    capabilities: null,
    diagnostic: null,
  }
}

export async function probeSepoliaProviders(profile, {
  requestJson,
  now = () => new Date().toISOString(),
} = {}) {
  assertReadonlyProfile(profile)
  if (typeof requestJson !== 'function') fail('INVALID_REQUEST_ADAPTER', 'requestJson must be a function')

  let requestCount = 0
  let active = 0
  let observedMaxConcurrency = 0
  const waiters = []

  const acquire = async () => {
    if (active >= profile.limits.maxConcurrency) {
      await new Promise((resolve) => waiters.push(resolve))
    }
    active += 1
    observedMaxConcurrency = Math.max(observedMaxConcurrency, active)
  }

  const release = () => {
    active -= 1
    waiters.shift()?.()
  }

  const boundedRequest = async (spec) => {
    if (requestCount >= profile.limits.maxRequests) fail('REQUEST_LIMIT_EXCEEDED', 'provider probe request limit exceeded')
    requestCount += 1
    await acquire()
    try {
      return await requestJson(spec)
    } finally {
      release()
    }
  }

  const execution = baseProviderReport(profile.providers.execution)
  const beacon = baseProviderReport(profile.providers.beacon)
  const identityResults = await Promise.allSettled([
    executionIdentity(profile, boundedRequest),
    beaconIdentity(profile, boundedRequest),
  ])

  if (identityResults[0].status === 'fulfilled') execution.identity = identityResults[0].value
  else execution.diagnostic = errorDiagnostic(identityResults[0].reason)
  if (identityResults[1].status === 'fulfilled') beacon.identity = identityResults[1].value
  else beacon.diagnostic = errorDiagnostic(identityResults[1].reason)

  const identitiesPassed = identityResults.every(({ status }) => status === 'fulfilled')
  if (identitiesPassed) {
    const capabilityResults = await Promise.allSettled([
      probeExecutionCapabilities(profile, boundedRequest),
      probeBeaconCapabilities(profile, boundedRequest),
    ])
    if (capabilityResults[0].status === 'fulfilled') {
      execution.capabilities = capabilityResults[0].value
      execution.result = execution.capabilities.blobAwareBlockRead ? 'PASS' : 'CAPABILITY_GAP'
    } else {
      execution.diagnostic = errorDiagnostic(capabilityResults[0].reason)
      execution.result = 'FAIL'
    }
    if (capabilityResults[1].status === 'fulfilled') {
      beacon.capabilities = capabilityResults[1].value
      const blobEndpointAvailable = ['available_empty', 'available_data'].includes(beacon.capabilities.currentBlobs.outcome)
      const legacyEndpointAvailable = ['available_empty', 'available_data'].includes(beacon.capabilities.legacySidecars.outcome)
      beacon.result = blobEndpointAvailable || legacyEndpointAvailable ? 'PASS' : 'CAPABILITY_GAP'
    } else {
      beacon.diagnostic = errorDiagnostic(capabilityResults[1].reason)
      beacon.result = 'FAIL'
    }
  } else {
    execution.result = execution.identity ? 'IDENTITY_ONLY' : 'FAIL'
    beacon.result = beacon.identity ? 'IDENTITY_ONLY' : 'FAIL'
  }

  const result = identitiesPassed && execution.result === 'PASS' && beacon.result === 'PASS'
    ? 'PASS'
    : identitiesPassed && ![execution.result, beacon.result].includes('FAIL')
      ? 'PASS_WITH_CAPABILITY_GAPS'
      : 'FAIL'

  return Object.freeze({
    schema: 'blobmail.sepolia-provider-probe.v0',
    generatedAt: now(),
    result,
    mode: profile.mode,
    network: profile.network,
    expectedIdentity: Object.freeze({
      executionChainId: profile.chain.id,
      beaconGenesis: SEPOLIA_GENESIS,
    }),
    limits: profile.limits,
    accounting: Object.freeze({ requestCount, observedMaxConcurrency }),
    providers: Object.freeze({ execution: Object.freeze(execution), beacon: Object.freeze(beacon) }),
    redaction: Object.freeze({
      providerUrlsPersisted: false,
      queryStringsPersisted: false,
      responseBodiesPersisted: false,
      diagnosticsAllowlisted: true,
    }),
    negativeClaims: Object.freeze({
      walletAccess: false,
      signing: false,
      transactionConstruction: false,
      transactionBroadcast: false,
      kzgProofVerified: false,
      chainInclusionVerified: false,
    }),
  })
}

export const SEPOLIA_READ_ONLY_EXECUTION_METHODS = EXECUTION_METHODS
