import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { SEPOLIA_CHAIN_ID, SEPOLIA_GENESIS } from '../src/network/index.js'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

test('checked-in live receipt is a redacted successful Sepolia capability observation', async () => {
  const raw = await readFile('reports/sepolia-provider-probe.json', 'utf8')
  const report = JSON.parse(raw)

  assert.equal(report.schema, 'blobmail.sepolia-provider-probe.v0')
  assert.equal(report.result, 'PASS')
  assert.equal(report.expectedIdentity.executionChainId, SEPOLIA_CHAIN_ID)
  assert.deepEqual(report.expectedIdentity.beaconGenesis, SEPOLIA_GENESIS)
  assert.equal(report.providers.execution.identity.chainId, SEPOLIA_CHAIN_ID)
  assert.equal(report.providers.execution.capabilities.blobTransactionRead, 'observed_in_latest_block')
  assert.ok(report.providers.execution.capabilities.blobTransactionsObserved > 0)
  assert.deepEqual(report.providers.beacon.identity, SEPOLIA_GENESIS)
  assert.equal(report.accounting.requestCount, 9)
  assert.ok(report.accounting.observedMaxConcurrency <= report.limits.maxConcurrency)
  assert.equal(report.redaction.providerUrlsPersisted, false)
  assert.equal(report.redaction.responseBodiesPersisted, false)
  assert.equal(report.negativeClaims.walletAccess, false)
  assert.equal(report.negativeClaims.transactionBroadcast, false)
  assert.match(report.runtime.node, /^v[0-9]+\./)
  assert.equal(report.runtime.packageManager, 'pnpm@11.16.0')
  assert.equal(report.commands.live, 'pnpm run probe:sepolia')
  assert.equal(report.commands.workspace, 'pnpm verify')
  assert.equal(report.publicSourceProvenance.commit, 'b465e02f88bbca85932344228c1cfe5abfb51253')
  assert.equal(report.publicSourceProvenance.reuseNegativeClaims.keyMaterialAccessed, false)
  assert.deepEqual(report.failures, [])
  assert.match(report.evidence.observationSha256, /^[0-9a-f]{64}$/)
  assert.equal(report.evidence.observationSha256, sha256(JSON.stringify({
    expectedIdentity: report.expectedIdentity,
    accounting: report.accounting,
    providers: report.providers,
    negativeClaims: report.negativeClaims,
  })))
  assert.equal(report.evidence.artifacts.length, 10)
  assert.ok(report.evidence.artifacts.every(({ path, sha256 }) => (
    typeof path === 'string' && /^[0-9a-f]{64}$/.test(sha256)
  )))
  for (const artifact of report.evidence.artifacts) {
    assert.equal(artifact.sha256, sha256(await readFile(artifact.path)), artifact.path)
  }
  assert.doesNotMatch(raw, /[?&](?:api[_-]?key|token|authorization)=|private[_-]?key|mnemonic/i)
  assert.doesNotMatch(raw, /https:\/\/[^/\s:@]+:[^@\s]+@/)
})

test('source provenance pins public eth-radio files and excludes wallet behavior', async () => {
  const provenance = JSON.parse(await readFile('reports/sepolia-source-provenance.json', 'utf8'))
  assert.equal(provenance.source.repository, 'https://github.com/bonklek/eth-radio')
  assert.equal(provenance.source.commit, 'b465e02f88bbca85932344228c1cfe5abfb51253')
  assert.deepEqual(
    provenance.source.files.map(({ gitBlob }) => gitBlob),
    [
      '84e71ec62f6dcdae85c0e47fb670a025f8778689',
      '4dc161ce326f6a25b8aec15f087eb3daf47bdfc3',
      '6d1716e2cea4de51f78850112065e3249ce7556a',
    ],
  )
  assert.equal(provenance.negativeClaims.walletCodeCopied, false)
  assert.equal(provenance.negativeClaims.keyMaterialAccessed, false)
  assert.deepEqual(provenance.excludedRepositories, ['eth-radio-private-unsafe-history'])
})

test('browser-importable network core has no ambient environment or network adapter', async () => {
  const files = ['src/network/profile.js', 'src/network/probe.js', 'src/network/index.js']
  const source = (await Promise.all(files.map((path) => readFile(path, 'utf8')))).join('\n')
  assert.doesNotMatch(source, /process\.env|node:https?|\bfetch\s*\(|WebSocket|EventSource/)
  assert.doesNotMatch(source, /eth_sendRawTransaction|eth_sendTransaction|privateKeyToAccount|createWalletClient/)
  assert.match(await readFile('.env.example', 'utf8'), /BLOBMAIL_NETWORK_MODE=offline/)
})
