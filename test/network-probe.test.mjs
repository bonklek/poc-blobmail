import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ProviderProbeError,
  SEPOLIA_GENESIS,
  createNetworkProfile,
  probeSepoliaProviders,
} from '../src/network/index.js'

const PROFILE = createNetworkProfile({
  BLOBMAIL_NETWORK_MODE: 'readonly',
  BLOBMAIL_NETWORK: 'sepolia',
  BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL: 'https://sepolia.drpc.org',
  BLOBMAIL_SEPOLIA_BEACON_RPC_URL: 'https://ethereum-sepolia-beacon-api.publicnode.com',
})

function rpc(result, id, statusCode = 200) {
  return { statusCode, body: { jsonrpc: '2.0', id, result } }
}

function beacon(data, statusCode = 200) {
  return { statusCode, body: { data } }
}

function fixtureRequester({ chainId = '0xaa36a7', legacyStatus = 200, currentStatus = 400 } = {}) {
  const calls = []
  let active = 0
  let maxActive = 0
  const requestJson = async (spec) => {
    calls.push(spec)
    active += 1
    maxActive = Math.max(maxActive, active)
    await Promise.resolve()
    try {
      if (spec.role === 'execution') {
        switch (spec.body.method) {
          case 'eth_chainId': return rpc(chainId, spec.body.id)
          case 'eth_blockNumber': return rpc('0x5f5e100', spec.body.id)
          case 'eth_getBlockByNumber':
            return rpc({
              number: '0x5f5e0ff',
              hash: `0x${'11'.repeat(32)}`,
              blobGasUsed: '0x0',
              excessBlobGas: '0x1',
              parentBeaconBlockRoot: `0x${'22'.repeat(32)}`,
              transactions: [
                { type: '0x2' },
                { type: '0x3', blobVersionedHashes: [`0x${'33'.repeat(32)}`] },
              ],
            }, spec.body.id)
          case 'eth_getTransactionByHash': return rpc(null, spec.body.id)
          default: throw new Error(`unexpected method ${spec.body.method}`)
        }
      }

      if (spec.url.pathname === '/eth/v1/beacon/genesis') {
        return beacon({
          genesis_time: SEPOLIA_GENESIS.time,
          genesis_fork_version: SEPOLIA_GENESIS.forkVersion,
          genesis_validators_root: SEPOLIA_GENESIS.validatorsRoot,
        })
      }
      if (spec.url.pathname === '/eth/v1/beacon/headers/head') {
        return beacon({ header: { message: { slot: '9000100' } } })
      }
      if (spec.url.pathname === '/eth/v1/beacon/headers/finalized') {
        return beacon({ header: { message: { slot: '9000000' } } })
      }
      if (spec.url.pathname === '/eth/v1/beacon/blob_sidecars/head') {
        return legacyStatus === 200 ? beacon([]) : { statusCode: legacyStatus, body: { code: legacyStatus } }
      }
      if (spec.url.pathname === '/eth/v1/beacon/blobs/head') {
        return currentStatus === 200 ? beacon([]) : { statusCode: currentStatus, body: { code: currentStatus } }
      }
      throw new Error(`unexpected endpoint ${spec.url.pathname}`)
    } finally {
      active -= 1
    }
  }
  return { requestJson, calls, maxActive: () => maxActive }
}

test('probe verifies both identities before bounded independent capability checks', async () => {
  const fixture = fixtureRequester()
  const report = await probeSepoliaProviders(PROFILE, {
    requestJson: fixture.requestJson,
    now: () => '2026-08-10T00:00:00.000Z',
  })

  assert.equal(report.result, 'PASS')
  assert.equal(report.generatedAt, '2026-08-10T00:00:00.000Z')
  assert.equal(report.accounting.requestCount, 9)
  assert.equal(report.accounting.observedMaxConcurrency, 2)
  assert.equal(fixture.maxActive(), 2)
  assert.equal(report.providers.execution.identity.chainId, 11_155_111)
  assert.equal(report.providers.execution.capabilities.blobAwareBlockRead, true)
  assert.equal(report.providers.execution.capabilities.blobTransactionsObserved, 1)
  assert.equal(report.providers.execution.capabilities.blobTransactionRead, 'observed_in_latest_block')
  assert.equal(report.providers.execution.capabilities.transactionReadMethod, 'supported_null_sentinel')
  assert.equal(report.providers.beacon.capabilities.legacySidecars.outcome, 'available_empty')
  assert.equal(report.providers.beacon.capabilities.currentBlobs.outcome, 'available_rejected_sentinel')
  assert.equal(report.negativeClaims.transactionBroadcast, false)
  assert.equal(report.redaction.providerUrlsPersisted, false)
  assert.ok(fixture.calls.every(({ method }) => method === 'GET' || method === 'POST'))
})

test('chain mismatch stops after the two identity requests and emits no capability claim', async () => {
  const fixture = fixtureRequester({ chainId: '0x1' })
  const report = await probeSepoliaProviders(PROFILE, { requestJson: fixture.requestJson })

  assert.equal(report.result, 'FAIL')
  assert.equal(report.accounting.requestCount, 2)
  assert.equal(report.providers.execution.diagnostic.code, 'CHAIN_ID_MISMATCH')
  assert.equal(report.providers.execution.capabilities, null)
  assert.equal(report.providers.beacon.capabilities, null)
})

test('unsupported blob endpoints are reported as an independent capability gap', async () => {
  const fixture = fixtureRequester({ legacyStatus: 404, currentStatus: 404 })
  const report = await probeSepoliaProviders(PROFILE, { requestJson: fixture.requestJson })

  assert.equal(report.result, 'PASS_WITH_CAPABILITY_GAPS')
  assert.equal(report.providers.execution.result, 'PASS')
  assert.equal(report.providers.beacon.result, 'CAPABILITY_GAP')
  assert.equal(report.providers.beacon.capabilities.legacySidecars.outcome, 'unsupported')
  assert.equal(report.providers.beacon.capabilities.currentBlobs.outcome, 'unsupported')
})

test('offline profile rejects before invoking a request adapter', async () => {
  let calls = 0
  await assert.rejects(
    probeSepoliaProviders(createNetworkProfile(), { requestJson: async () => { calls += 1 } }),
    (error) => error instanceof ProviderProbeError && error.code === 'NETWORK_DISABLED',
  )
  assert.equal(calls, 0)
})

test('unexpected request failures persist only allowlisted diagnostics', async () => {
  const report = await probeSepoliaProviders(PROFILE, {
    requestJson: async () => { throw new Error('secret-bearing https://provider.example/key') },
  })
  const serialized = JSON.stringify(report)
  assert.equal(report.result, 'FAIL')
  assert.equal(report.providers.execution.diagnostic.code, 'PROVIDER_REQUEST_FAILED')
  assert.equal(serialized.includes('provider.example'), false)
  assert.equal(serialized.includes('secret-bearing'), false)
})

test('execution JSON-RPC allowlist contains reads only', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile('src/network/probe.js', 'utf8'))
  assert.match(source, /eth_chainId/)
  assert.match(source, /eth_getBlockByNumber/)
  assert.doesNotMatch(source, /eth_sendRawTransaction|eth_sendTransaction|signTransaction|walletClient/)
})
