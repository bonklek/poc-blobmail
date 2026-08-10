import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:https'

import { createNetworkProfile, probeSepoliaProviders } from '../src/network/index.js'

const OUTPUT = 'reports/sepolia-provider-probe.json'
const EVIDENCE_ARTIFACTS = Object.freeze([
  '.env.example',
  'src/network/index.js',
  'src/network/profile.js',
  'src/network/probe.js',
  'scripts/probe-sepolia-providers.mjs',
  'reports/sepolia-source-provenance.json',
  'docs/sepolia-provider-profile.md',
  'test/network-profile.test.mjs',
  'test/network-probe.test.mjs',
  'test/sepolia-probe-receipt.test.mjs',
])

class BoundedRequestError extends Error {
  constructor(code) {
    super(code)
    this.name = 'BoundedRequestError'
    this.code = code
  }
}

function boundedHttpsJson(spec) {
  if (!spec || !(spec.url instanceof URL) || spec.url.protocol !== 'https:') {
    throw new BoundedRequestError('INVALID_REQUEST_TARGET')
  }
  if (!['GET', 'POST'].includes(spec.method)) throw new BoundedRequestError('METHOD_NOT_ALLOWED')
  if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > 10_000) {
    throw new BoundedRequestError('INVALID_TIMEOUT_LIMIT')
  }
  if (!Number.isInteger(spec.maxResponseBytes) || spec.maxResponseBytes < 1 || spec.maxResponseBytes > 1_048_576) {
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
      'user-agent': 'BlobMail-Sepolia-ReadOnly-Probe/0',
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
        resolve({ statusCode: incoming.statusCode, body })
      })
    })

    outgoing.on('timeout', () => outgoing.destroy(new BoundedRequestError('REQUEST_TIMEOUT')))
    outgoing.on('error', (error) => finishReject(error instanceof BoundedRequestError ? error.code : 'REQUEST_FAILED'))
    if (serializedBody !== null) outgoing.write(serializedBody)
    outgoing.end()
  })
}

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
