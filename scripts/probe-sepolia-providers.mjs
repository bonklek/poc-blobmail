import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { createNetworkProfile, probeSepoliaProviders } from '../src/network/index.js'
import { boundedHttpsJson } from '../src/network/node-https.js'

const OUTPUT = 'reports/sepolia-provider-probe.json'
const EVIDENCE_ARTIFACTS = Object.freeze([
  '.env.example',
  'src/network/index.js',
  'src/network/profile.js',
  'src/network/probe.js',
  'src/network/node-https.js',
  'scripts/probe-sepolia-providers.mjs',
  'reports/sepolia-source-provenance.json',
  'docs/sepolia-provider-profile.md',
  'test/network-profile.test.mjs',
  'test/network-probe.test.mjs',
  'test/sepolia-probe-receipt.test.mjs',
])

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function artifact(path) {
  return { path, sha256: sha256(await readFile(path)) }
}

async function enrichReport(report) {
  const packageMetadata = JSON.parse(await readFile('package.json', 'utf8'))
  const provenance = JSON.parse(await readFile('reports/sepolia-source-provenance.json', 'utf8'))
  const failures = Object.entries(report.providers).flatMap(([role, provider]) => {
    if (provider.diagnostic) return [{ role, ...provider.diagnostic }]
    if (provider.result === 'CAPABILITY_GAP') return [{ role, code: 'CAPABILITY_GAP', category: 'ProviderCapability' }]
    return []
  })
  const observation = {
    expectedIdentity: report.expectedIdentity,
    accounting: report.accounting,
    providers: report.providers,
    negativeClaims: report.negativeClaims,
  }
  return {
    ...report,
    runtime: {
      node: process.version,
      v8: process.versions.v8,
      openssl: process.versions.openssl,
      packageManager: packageMetadata.packageManager,
      adapter: 'node:https',
    },
    commands: {
      live: 'pnpm run probe:sepolia',
      fixture: 'node --test test/network-profile.test.mjs test/network-probe.test.mjs test/sepolia-probe-receipt.test.mjs',
      workspace: 'pnpm verify',
    },
    activationEnvironment: [
      'BLOBMAIL_NETWORK_MODE',
      'BLOBMAIL_NETWORK',
      'BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL',
      'BLOBMAIL_SEPOLIA_BEACON_RPC_URL',
      'BLOBMAIL_SEPOLIA_ALLOWED_HOSTS',
    ],
    publicSourceProvenance: {
      repository: provenance.source.repository,
      commit: provenance.source.commit,
      files: provenance.source.files.map(({ path, gitBlob }) => ({ path, gitBlob })),
      excludedRepositories: provenance.excludedRepositories,
      reuseNegativeClaims: provenance.negativeClaims,
    },
    failures,
    evidence: {
      observationSha256: sha256(JSON.stringify(observation)),
      artifacts: await Promise.all(EVIDENCE_ARTIFACTS.map(artifact)),
    },
  }
}

try {
  const profile = createNetworkProfile(process.env)
  const report = await enrichReport(await probeSepoliaProviders(profile, { requestJson: boundedHttpsJson }))
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
  console.log(JSON.stringify({
    result: report.result,
    output: OUTPUT,
    providers: {
      execution: report.providers.execution.providerId,
      beacon: report.providers.beacon.providerId,
    },
    requests: report.accounting.requestCount,
  }, null, 2))
  if (report.result === 'FAIL') process.exitCode = 1
} catch (error) {
  console.error(JSON.stringify({
    result: 'FAIL',
    code: typeof error?.code === 'string' ? error.code : 'PROBE_SETUP_FAILED',
  }))
  process.exitCode = 1
}
