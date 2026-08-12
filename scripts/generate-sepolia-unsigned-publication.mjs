import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJsonBytes } from '../src/publication/canonical-json.js'
import { generateUnsignedPublicationPackage } from '../src/publication/package.js'
import { loadNodeKzg } from '../src/sidecars/node-kzg.js'
import { hexToBytes, sha256Hex } from '../src/transport/index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = `${ROOT}/artifacts/sepolia-unsigned-publication-v1`
const readJson = async (path) => JSON.parse(await readFile(`${ROOT}/${path}`, 'utf8'))

const fixture = await readJson('vectors/blobmail-v0.json')
const config = await readJson('vectors/sepolia-publication-input-v1.json')
if (config.schema !== 'blobmail.sepolia-publication-input.v1') throw new Error('unknown publication input schema')
const { schema: ignoredSchema, ...publicConfig } = config
void ignoredSchema
const batchBytes = hexToBytes(`0x${fixture.batch.batchHex}`)
const generated = await generateUnsignedPublicationPackage({ ...publicConfig, batchBytes }, { kzg: await loadNodeKzg() })
const sourceProvenance = await readJson('reports/sepolia-unsigned-source-provenance.json')
const manifest = {
  ...generated.manifest,
  fixture: {
    source: 'vectors/blobmail-v0.json',
    warning: 'Public deterministic ciphertext fixture only; no fixture private material is copied into this package.',
    alice: { identityId: fixture.identities.alice.identityId, publicKeyHex: fixture.identities.alice.publicKeyHex },
    bob: { identityId: fixture.identities.bob.identityId, publicKeyHex: fixture.identities.bob.publicKeyHex },
  },
  provenance: sourceProvenance,
  command: 'pnpm run package:sepolia:unsigned',
}
const files = {
  'batch.bin': batchBytes,
  'blob-0.bin': generated.blob,
  'blob-sidecar.json': canonicalJsonBytes(generated.sidecar),
  'unsigned-request.json': canonicalJsonBytes(generated.unsignedRequest),
  'manifest.json': canonicalJsonBytes(manifest),
}
await mkdir(OUTPUT, { recursive: true })
for (const [name, bytes] of Object.entries(files)) await writeFile(`${OUTPUT}/${name}`, bytes)

const artifacts = []
for (const [name, bytes] of Object.entries(files)) {
  artifacts.push({
    path: `artifacts/sepolia-unsigned-publication-v1/${name}`,
    bytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
  })
}
for (const path of [
  'vectors/sepolia-publication-input-v1.json',
  'reports/sepolia-unsigned-source-provenance.json',
  'src/publication/canonical-json.js',
  'src/publication/cost.js',
  'src/publication/package.js',
  'scripts/generate-sepolia-unsigned-publication.mjs',
]) {
  const bytes = new Uint8Array(await readFile(`${ROOT}/${path}`))
  artifacts.push({ path, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) })
}
const report = {
  schema: 'blobmail.sepolia-unsigned-publication-report.v1',
  result: 'PASS_FIXTURE',
  issue: 'https://github.com/bonklek/blobmail/issues/7',
  branch: 'codex/7-unsigned-sepolia-package',
  command: 'pnpm run package:sepolia:unsigned',
  deterministic: true,
  chainId: '11155111',
  expectedPublisherAddress: manifest.expectedPublisherAddress,
  batchId: manifest.batch.batchId,
  blobVersionedHashes: manifest.blobs.map(({ versionedHash }) => versionedHash),
  kzgProofVerified: manifest.blobs.every(({ kzgProofVerified }) => kzgProofVerified),
  costs: manifest.costs,
  caps: manifest.caps,
  expiry: manifest.expiry,
  safety: {
    unsigned: true,
    fixturePublisherOnly: true,
    containsSecretMaterial: false,
    containsAuthenticatedEndpoint: false,
    containsSignature: false,
    containsSubmissionCapability: false,
  },
  artifacts,
}
await writeFile(`${ROOT}/reports/sepolia-unsigned-publication.json`, canonicalJsonBytes(report))
console.log(`wrote ${artifacts.length} bound artifacts for unsigned Sepolia review`)
