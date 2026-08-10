import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NetworkProfileError,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_GENESIS,
  SEPOLIA_PROBE_LIMITS,
  createNetworkProfile,
  providerRequestUrl,
} from '../src/network/index.js'

const READONLY_ENV = Object.freeze({
  BLOBMAIL_NETWORK_MODE: 'readonly',
  BLOBMAIL_NETWORK: 'sepolia',
  BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL: 'https://sepolia.drpc.org',
  BLOBMAIL_SEPOLIA_BEACON_RPC_URL: 'https://ethereum-sepolia-beacon-api.publicnode.com',
})

test('network profile is offline by default and carries pinned Sepolia identity', () => {
  const profile = createNetworkProfile()
  assert.equal(profile.mode, 'offline')
  assert.equal(profile.providers, null)
  assert.equal(profile.chain.id, SEPOLIA_CHAIN_ID)
  assert.deepEqual(profile.chain.genesis, SEPOLIA_GENESIS)
  assert.deepEqual(profile.limits, SEPOLIA_PROBE_LIMITS)
})

test('read-only profile separates execution and beacon providers with deterministic redacted IDs', () => {
  const first = createNetworkProfile(READONLY_ENV)
  const second = createNetworkProfile({ ...READONLY_ENV })

  assert.equal(first.mode, 'readonly')
  assert.equal(first.providers.execution.providerId, 'blobmail-sepolia-v0:execution:sepolia.drpc.org')
  assert.equal(first.providers.beacon.providerId, 'blobmail-sepolia-v0:beacon:ethereum-sepolia-beacon-api.publicnode.com')
  assert.equal(first.providers.execution.providerId, second.providers.execution.providerId)
  assert.equal(first.providers.execution.origin, 'https://sepolia.drpc.org')
  assert.equal(providerRequestUrl(first.providers.beacon, '/eth/v1/beacon/genesis').pathname, '/eth/v1/beacon/genesis')
})

test('unknown network and non-read-only modes fail before a provider can be used', () => {
  assert.throws(
    () => createNetworkProfile({ ...READONLY_ENV, BLOBMAIL_NETWORK: 'mainnet' }),
    (error) => error instanceof NetworkProfileError && error.code === 'UNSUPPORTED_NETWORK',
  )
  assert.throws(
    () => createNetworkProfile({ ...READONLY_ENV, BLOBMAIL_NETWORK_MODE: 'write' }),
    (error) => error instanceof NetworkProfileError && error.code === 'UNSUPPORTED_NETWORK_MODE',
  )
})

test('read-only mode requires separate environment-provided endpoints', () => {
  assert.throws(
    () => createNetworkProfile({ ...READONLY_ENV, BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL: '' }),
    (error) => error instanceof NetworkProfileError && error.code === 'MISSING_PROVIDER_URL',
  )
  assert.throws(
    () => createNetworkProfile({
      ...READONLY_ENV,
      BLOBMAIL_SEPOLIA_BEACON_RPC_URL: READONLY_ENV.BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL,
    }),
    (error) => error instanceof NetworkProfileError && error.code === 'PROVIDER_ROLES_NOT_SEPARATE',
  )
})

test('provider URL policy rejects plaintext, embedded authority, paths, queries, and unlisted hosts', () => {
  const cases = [
    ['http://sepolia.drpc.org', 'INSECURE_PROVIDER_URL'],
    ['https://user:secret@sepolia.drpc.org', 'CREDENTIAL_BEARING_PROVIDER_URL'],
    ['https://sepolia.drpc.org/key/secret', 'CREDENTIAL_BEARING_PROVIDER_URL'],
    ['https://sepolia.drpc.org?apiKey=secret', 'CREDENTIAL_BEARING_PROVIDER_URL'],
    ['https://example.com', 'PROVIDER_HOST_NOT_ALLOWED'],
  ]
  for (const [value, code] of cases) {
    assert.throws(
      () => createNetworkProfile({ ...READONLY_ENV, BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL: value }),
      (error) => error instanceof NetworkProfileError && error.code === code,
      value,
    )
  }
})

test('additional provider hostnames require an explicit bounded allowlist', () => {
  const profile = createNetworkProfile({
    ...READONLY_ENV,
    BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL: 'https://rpc.example.org',
    BLOBMAIL_SEPOLIA_ALLOWED_HOSTS: 'rpc.example.org,ethereum-sepolia-beacon-api.publicnode.com',
  })
  assert.equal(profile.providers.execution.hostname, 'rpc.example.org')

  assert.throws(
    () => createNetworkProfile({ ...READONLY_ENV, BLOBMAIL_SEPOLIA_ALLOWED_HOSTS: 'sepolia.drpc.org,sepolia.drpc.org' }),
    (error) => error instanceof NetworkProfileError && error.code === 'INVALID_PROVIDER_ALLOWLIST',
  )
  for (const hostname of ['localhost', '127.0.0.1', 'provider.internal']) {
    assert.throws(
      () => createNetworkProfile({
        ...READONLY_ENV,
        BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL: `https://${hostname}`,
        BLOBMAIL_SEPOLIA_ALLOWED_HOSTS: `${hostname},ethereum-sepolia-beacon-api.publicnode.com`,
      }),
      (error) => error instanceof NetworkProfileError && error.code === 'INVALID_PROVIDER_ALLOWLIST',
    )
  }
})
