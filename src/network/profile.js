const HTTPS_PROTOCOL = 'https:'

export const SEPOLIA_CHAIN_ID = 11_155_111
export const SEPOLIA_CHAIN_ID_HEX = '0xaa36a7'
export const SEPOLIA_GENESIS = Object.freeze({
  time: '1655733600',
  forkVersion: '0x90000069',
  validatorsRoot: '0xd8ea171f3c94aea21ebc42a1ed61052acf3f9209c00e4efbaaddac09ed9b8078',
})

export const SEPOLIA_PROBE_LIMITS = Object.freeze({
  timeoutMs: 8_000,
  executionResponseBytes: 1_048_576,
  beaconResponseBytes: 393_216,
  maxConcurrency: 2,
  maxRequests: 9,
})

export const DEFAULT_SEPOLIA_PROVIDER_HOSTS = Object.freeze([
  'sepolia.drpc.org',
  'ethereum-sepolia-rpc.publicnode.com',
  'ethereum-sepolia-beacon-api.publicnode.com',
])

const ENV = Object.freeze({
  mode: 'BLOBMAIL_NETWORK_MODE',
  network: 'BLOBMAIL_NETWORK',
  executionUrl: 'BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL',
  beaconUrl: 'BLOBMAIL_SEPOLIA_BEACON_RPC_URL',
  allowedHosts: 'BLOBMAIL_SEPOLIA_ALLOWED_HOSTS',
})

export class NetworkProfileError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'NetworkProfileError'
    this.code = code
  }
}

function fail(code, message) {
  throw new NetworkProfileError(code, message)
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeHost(value) {
  return value.trim().toLowerCase().replace(/\.$/, '')
}

function parseAllowedHosts(value) {
  const source = cleanString(value)
  const hosts = source
    ? source.split(',').map(normalizeHost).filter(Boolean)
    : [...DEFAULT_SEPOLIA_PROVIDER_HOSTS]

  if (hosts.length === 0 || hosts.length > 8 || new Set(hosts).size !== hosts.length) {
    fail('INVALID_PROVIDER_ALLOWLIST', `${ENV.allowedHosts} must contain 1 to 8 unique hostnames`)
  }

  for (const host of hosts) {
    const isIpv4Literal = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(host)
    if (
      host.length > 253
      || !host.includes('.')
      || isIpv4Literal
      || host.endsWith('.local')
      || host.endsWith('.internal')
      || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    ) {
      fail('INVALID_PROVIDER_ALLOWLIST', `${ENV.allowedHosts} contains an invalid hostname`)
    }
  }

  return Object.freeze(hosts)
}

function parseProviderUrl(value, role, allowedHosts) {
  const source = cleanString(value)
  if (!source) fail('MISSING_PROVIDER_URL', `${role} provider URL is required in read-only mode`)

  let url
  try {
    url = new URL(source)
  } catch {
    fail('INVALID_PROVIDER_URL', `${role} provider URL is not a valid absolute URL`)
  }

  const hostname = normalizeHost(url.hostname)
  if (url.protocol !== HTTPS_PROTOCOL) {
    fail('INSECURE_PROVIDER_URL', `${role} provider URL must use HTTPS`)
  }
  if (url.username || url.password || url.search || url.hash) {
    fail('CREDENTIAL_BEARING_PROVIDER_URL', `${role} provider URL cannot contain credentials, query parameters, or a fragment`)
  }
  if (url.port && url.port !== '443') {
    fail('INVALID_PROVIDER_URL', `${role} provider URL must use the default HTTPS port`)
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    fail('CREDENTIAL_BEARING_PROVIDER_URL', `${role} provider URL must not contain a path`)
  }
  if (!allowedHosts.includes(hostname)) {
    fail('PROVIDER_HOST_NOT_ALLOWED', `${role} provider hostname is not explicitly allowlisted`)
  }

  return Object.freeze({
    role,
    providerId: `blobmail-sepolia-v0:${role}:${hostname}`,
    hostname,
    origin: `${HTTPS_PROTOCOL}//${hostname}`,
  })
}

function offlineProfile() {
  return Object.freeze({
    schema: 'blobmail.network-profile.v0',
    mode: 'offline',
    network: 'sepolia',
    chain: Object.freeze({
      id: SEPOLIA_CHAIN_ID,
      idHex: SEPOLIA_CHAIN_ID_HEX,
      genesis: SEPOLIA_GENESIS,
    }),
    providers: null,
    limits: SEPOLIA_PROBE_LIMITS,
  })
}

export function createNetworkProfile(env = Object.create(null)) {
  if (!env || typeof env !== 'object') fail('INVALID_ENVIRONMENT', 'environment must be an object')

  const mode = cleanString(env[ENV.mode]) || 'offline'
  const network = cleanString(env[ENV.network]) || 'sepolia'

  if (mode !== 'offline' && mode !== 'readonly') {
    fail('UNSUPPORTED_NETWORK_MODE', `${ENV.mode} must be offline or readonly`)
  }
  if (network !== 'sepolia') {
    fail('UNSUPPORTED_NETWORK', `unsupported network ${JSON.stringify(network)}`)
  }
  if (mode === 'offline') return offlineProfile()

  const allowedHosts = parseAllowedHosts(env[ENV.allowedHosts])
  const execution = parseProviderUrl(env[ENV.executionUrl], 'execution', allowedHosts)
  const beacon = parseProviderUrl(env[ENV.beaconUrl], 'beacon', allowedHosts)
  if (execution.hostname === beacon.hostname) {
    fail('PROVIDER_ROLES_NOT_SEPARATE', 'execution and beacon providers must use separate hostnames')
  }

  return Object.freeze({
    schema: 'blobmail.network-profile.v0',
    mode,
    network,
    chain: Object.freeze({
      id: SEPOLIA_CHAIN_ID,
      idHex: SEPOLIA_CHAIN_ID_HEX,
      genesis: SEPOLIA_GENESIS,
    }),
    providers: Object.freeze({ execution, beacon }),
    limits: SEPOLIA_PROBE_LIMITS,
  })
}

export function providerRequestUrl(provider, pathname) {
  if (!provider || typeof provider !== 'object' || !provider.origin) {
    fail('INVALID_PROVIDER', 'provider descriptor is required')
  }
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    fail('INVALID_PROVIDER_PATH', 'provider request path must be an absolute-path reference')
  }
  return new URL(pathname, `${provider.origin}/`)
}

export const NETWORK_PROFILE_ENV = ENV
