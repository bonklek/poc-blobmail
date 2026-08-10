import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { createNetworkProfile } from '../src/network/index.js'
import { boundedHttpsJson } from '../src/network/node-https.js'
import { loadNodeKzg, replaySepoliaBlobTransaction } from '../src/sidecars/index.js'

const OUTPUT = 'reports/sepolia-sidecar-live-replay.json'

function readArg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1]
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

const txHash = readArg('tx')
const manifestPath = readArg('manifest')
if (!txHash || !manifestPath) {
  console.error('Usage: pnpm probe:sidecars -- --tx 0x... --manifest path/to/public-manifest.json')
  process.exitCode = 1
} else {
  try {
    const manifestBytes = await readFile(manifestPath)
    if (manifestBytes.byteLength > 65_536) throw Object.assign(new Error('manifest too large'), { code: 'MANIFEST_TOO_LARGE' })
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    const profile = createNetworkProfile(process.env)
    const kzg = await loadNodeKzg()
    const replay = await replaySepoliaBlobTransaction({
      profile,
      txHash,
      manifest,
      requestJson: boundedHttpsJson,
      kzg,
    })
    const receipt = {
      ...replay,
      observationMode: 'explicit-readonly-live',
      payload: undefined,
      payloadBytes: replay.payload.byteLength,
      inputManifest: {
        pathPersisted: false,
        sha256: sha256(manifestBytes),
      },
      commands: {
        live: 'pnpm probe:sidecars -- --tx 0x... --manifest path/to/public-manifest.json',
        fixture: 'node --test test/sepolia-sidecar-replay.test.mjs',
      },
      negativeClaims: {
        walletAccessed: false,
        signerPresent: false,
        transactionConstructed: false,
        transactionSubmitted: false,
      },
    }
    await writeFile(OUTPUT, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
    console.log(JSON.stringify({ result: receipt.result, output: OUTPUT, transactionHash: receipt.provenance.transactionHash }, null, 2))
  } catch (error) {
    console.error(JSON.stringify({
      result: 'FAIL',
      code: typeof error?.code === 'string' ? error.code : 'SIDECAR_PROBE_FAILED',
    }))
    process.exitCode = 1
  }
}
