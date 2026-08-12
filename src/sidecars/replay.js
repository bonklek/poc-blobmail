/*
 * Read-only Sepolia sidecar replay. Public read-path concepts are adapted from
 * bonklek/eth-radio commit b465e02f88bbca85932344228c1cfe5abfb51253.
 * VPL notice: see THIRD_PARTY_NOTICES.md. There is no signing or submission API.
 */

import { parseBatch } from '../protocol/index.js'
import { decodeBlobMailBatchFromDeclaredSegment } from '../segments/index.js'
import {
  BLOB_BYTES,
  PAYLOAD_BYTES_PER_BLOB,
  bytesToHex,
  decodePayloadFromBlobs,
  selectSidecarsByVersionedHash,
  sha256Hex,
} from '../transport/index.js'
import { SEPOLIA_CHAIN_ID, SEPOLIA_GENESIS, providerRequestUrl } from '../network/index.js'

const HEX_32 = /^0x[0-9a-f]{64}$/i
const HEX_48 = /^0x[0-9a-f]{96}$/i
const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i
const DECIMAL = /^(?:0|[1-9][0-9]*)$/

export const SEPOLIA_SIDECAR_LIMITS = Object.freeze({
  maxBlobs: 6,
  maxBeaconProviders: 2,
  maxRequests: 20,
  timeoutMs: 10_000,
  executionResponseBytes: 1_048_576,
  beaconResponseBytes: 2_097_152,
})

export const SIDECAR_EVIDENCE_STATES = Object.freeze({
  BLOB_TRANSACTION_INCLUDED: 'BLOB_TRANSACTION_INCLUDED',
  SIDECARS_MATCHED: 'SIDECARS_MATCHED',
  KZG_PROOF_VERIFIED: 'KZG_PROOF_VERIFIED',
  BATCH_RECONSTRUCTED: 'BATCH_RECONSTRUCTED',
  PAYLOAD_SHA256_VERIFIED: 'PAYLOAD_SHA256_VERIFIED',
})

export class SidecarReplayError extends Error {
  constructor(code, message, evidence = []) {
    super(message)
    this.name = 'SidecarReplayError'
    this.code = code
    this.evidence = Object.freeze([...evidence])
  }
}

function fail(code, message, evidence = []) {
  throw new SidecarReplayError(code, message, evidence)
}

function hex(value, bytes, label) {
  const pattern = bytes === 32 ? HEX_32 : HEX_48
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail('INVALID_INPUT', `${label} must be ${bytes} bytes of hex`)
  }
  return value.toLowerCase()
}

function hexQuantity(value, label) {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) {
    fail('INVALID_PROVIDER_RESPONSE', `${label} is not a canonical hex quantity`)
  }
  const parsed = BigInt(value)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('INVALID_PROVIDER_RESPONSE', `${label} exceeds the safe range`)
  }
  return Number(parsed)
}

function decimal(value, label) {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    fail('INVALID_PROVIDER_RESPONSE', `${label} is not a canonical decimal integer`)
  }
  const parsed = BigInt(value)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('INVALID_PROVIDER_RESPONSE', `${label} exceeds the safe range`)
  }
  return Number(parsed)
}

function normalizeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('INVALID_MANIFEST', 'manifest must be an object')
  }
  const hashes = manifest.blobVersionedHashes
  if (!Array.isArray(hashes) || hashes.length < 1 || hashes.length > SEPOLIA_SIDECAR_LIMITS.maxBlobs) {
    fail('INVALID_MANIFEST', 'manifest must contain 1 to 6 blob versioned hashes')
  }
  const normalizedHashes = hashes.map((value, index) => hex(value, 32, `blobVersionedHashes[${index}]`))
  if (new Set(normalizedHashes).size !== normalizedHashes.length) {
    fail('DUPLICATE_EXPECTED_HASH', 'manifest versioned hashes must be unique')
  }
  const isDeclaredSegment = manifest.startFE !== undefined || manifest.endFE !== undefined
  if (isDeclaredSegment) {
    if (normalizedHashes.length !== 1) fail('INVALID_MANIFEST', 'a declared segment must identify exactly one blob')
    if (!Number.isSafeInteger(manifest.startFE) || !Number.isSafeInteger(manifest.endFE)
      || manifest.startFE < 0 || manifest.startFE >= manifest.endFE || manifest.endFE > 4096) {
      fail('INVALID_MANIFEST', 'declared segment field-element range is invalid')
    }
  } else if (!Number.isSafeInteger(manifest.payloadBytes)
    || manifest.payloadBytes < 1
    || manifest.payloadBytes > hashes.length * PAYLOAD_BYTES_PER_BLOB) {
    fail('INVALID_MANIFEST', 'manifest payloadBytes exceeds the declared blob capacity')
  }
  const payloadSha256 = manifest.payloadSha256 === undefined
    ? null
    : String(manifest.payloadSha256).toLowerCase().replace(/^0x/, '')
  if ((!isDeclaredSegment || payloadSha256 !== null) && !/^[0-9a-f]{64}$/.test(payloadSha256 ?? '')) {
    fail('INVALID_MANIFEST', 'manifest payloadSha256 must be a 32-byte digest')
  }
  const batchId = manifest.batchId === undefined ? null : String(manifest.batchId).toLowerCase().replace(/^0x/, '')
  if (batchId !== null && !/^[0-9a-f]{64}$/.test(batchId)) {
    fail('INVALID_MANIFEST', 'manifest batchId must be a 32-byte digest when present')
  }
  const expectedBeaconRoot = manifest.expectedBeaconRoot === undefined
    ? null
    : hex(manifest.expectedBeaconRoot, 32, 'expectedBeaconRoot')
  return Object.freeze({
    kind: isDeclaredSegment ? 'declared-segment' : 'payload',
    blobVersionedHashes: Object.freeze(normalizedHashes),
    payloadBytes: isDeclaredSegment ? null : manifest.payloadBytes,
    payloadSha256,
    batchId,
    expectedBeaconRoot,
    startFE: isDeclaredSegment ? manifest.startFE : null,
    endFE: isDeclaredSegment ? manifest.endFE : null,
  })
}

function assertProfile(profile) {
  if (!profile || profile.schema !== 'blobmail.network-profile.v0') {
    fail('INVALID_NETWORK_PROFILE', 'a BlobMail network profile is required')
  }
  if (profile.mode !== 'readonly' || !profile.providers) {
    fail('NETWORK_DISABLED', 'sidecar replay requires explicit readonly mode')
  }
  if (profile.network !== 'sepolia' || profile.chain.id !== SEPOLIA_CHAIN_ID) {
    fail('UNSUPPORTED_NETWORK', 'only the pinned Sepolia profile is supported')
  }
}

function normalizeBeaconSources(profile, requestJson, beaconSources) {
  const sources = beaconSources ?? [{ provider: profile.providers.beacon, requestJson }]
  if (!Array.isArray(sources)
    || sources.length < 1
    || sources.length > SEPOLIA_SIDECAR_LIMITS.maxBeaconProviders) {
    fail('INVALID_PROVIDER_SET', 'one or two beacon providers are required')
  }
  const normalized = sources.map((source, index) => {
    if (!source || typeof source !== 'object' || typeof source.requestJson !== 'function') {
      fail('INVALID_PROVIDER_SET', `beacon provider ${index} is invalid`)
    }
    const provider = source.provider
    if (!provider || provider.role !== 'beacon' || typeof provider.providerId !== 'string') {
      fail('INVALID_PROVIDER_SET', `beacon provider ${index} descriptor is invalid`)
    }
    let origin
    try {
      origin = new URL(provider.origin)
    } catch {
      fail('INVALID_PROVIDER_SET', `beacon provider ${index} origin is invalid`)
    }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash
      || origin.pathname !== '/' || (origin.port && origin.port !== '443')) {
      fail('INVALID_PROVIDER_SET', `beacon provider ${index} must be an HTTPS root origin`)
    }
    if (provider.providerId !== `blobmail-sepolia-v0:beacon:${origin.hostname.toLowerCase()}`) {
      fail('INVALID_PROVIDER_SET', `beacon provider ${index} ID does not match its origin`)
    }
    return Object.freeze({ provider, requestJson: source.requestJson })
  })
  if (new Set(normalized.map(({ provider }) => provider.providerId)).size !== normalized.length) {
    fail('INVALID_PROVIDER_SET', 'beacon provider IDs must be unique')
  }
  return normalized
}

function requestSpec(provider, pathname, method, body, maxResponseBytes) {
  return Object.freeze({
    role: provider.role,
    providerId: provider.providerId,
    url: providerRequestUrl(provider, pathname),
    method,
    headers: method === 'POST'
      ? Object.freeze({ accept: 'application/json', 'content-type': 'application/json' })
      : Object.freeze({ accept: 'application/json' }),
    body: body ?? null,
    timeoutMs: SEPOLIA_SIDECAR_LIMITS.timeoutMs,
    maxResponseBytes,
  })
}

async function boundedRequest(source, spec, accounting) {
  accounting.requests += 1
  if (accounting.requests > SEPOLIA_SIDECAR_LIMITS.maxRequests) {
    fail('REQUEST_LIMIT_EXCEEDED', 'sidecar replay exceeded its request limit')
  }
  try {
    return await source.requestJson(spec)
  } catch {
    fail('PROVIDER_REQUEST_FAILED', 'a bounded read-only provider request failed')
  }
}

function unwrapRpc(response, id, method) {
  if (!response || response.statusCode !== 200 || !response.body || typeof response.body !== 'object') {
    fail('PROVIDER_HTTP_ERROR', `${method} did not return HTTP 200 JSON`)
  }
  if (response.body.jsonrpc !== '2.0' || response.body.id !== id || response.body.error
    || !Object.hasOwn(response.body, 'result')) {
    fail('INVALID_PROVIDER_RESPONSE', `${method} returned an invalid JSON-RPC envelope`)
  }
  return response.body.result
}

function unwrapBeacon(response, label, { allowUnsupported = false } = {}) {
  if (allowUnsupported && [404, 410, 501].includes(response?.statusCode)) return null
  if (!response || response.statusCode !== 200 || !response.body || typeof response.body !== 'object') {
    fail('PROVIDER_HTTP_ERROR', `${label} did not return HTTP 200 JSON`)
  }
  if (!Object.hasOwn(response.body, 'data')) {
    fail('INVALID_PROVIDER_RESPONSE', `${label} omitted data`)
  }
  return response.body.data
}

function rpcBody(id, method, params = []) {
  if (!['eth_chainId', 'eth_getTransactionByHash', 'eth_getBlockByHash', 'eth_getBlockByNumber'].includes(method)) {
    fail('METHOD_NOT_ALLOWED', `execution method ${method} is not allowlisted`)
  }
  return Object.freeze({ jsonrpc: '2.0', id, method, params })
}

async function rpc(source, provider, accounting, id, method, params = []) {
  const response = await boundedRequest(source, requestSpec(
    provider,
    '/',
    'POST',
    rpcBody(id, method, params),
    SEPOLIA_SIDECAR_LIMITS.executionResponseBytes,
  ), accounting)
  return unwrapRpc(response, id, method)
}

async function beacon(source, accounting, pathname, label, options) {
  const response = await boundedRequest(source, requestSpec(
    source.provider,
    pathname,
    'GET',
    null,
    SEPOLIA_SIDECAR_LIMITS.beaconResponseBytes,
  ), accounting)
  return unwrapBeacon(response, label, options)
}

function evidence(state, details) {
  return Object.freeze({ state, details: Object.freeze(details) })
}

function executionBlockHash(beaconBlock) {
  return beaconBlock?.message?.body?.execution_payload?.block_hash
    ?? beaconBlock?.message?.body?.executionPayload?.blockHash
}

function normalizeSidecarArray(data, label) {
  if (!Array.isArray(data)) fail('INVALID_PROVIDER_RESPONSE', `${label} data must be an array`)
  if (data.length > SEPOLIA_SIDECAR_LIMITS.maxBlobs * 4) {
    fail('SIDECAR_LIMIT_EXCEEDED', `${label} returned too many sidecars`)
  }
  return data.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('INVALID_PROVIDER_RESPONSE', `${label} sidecar ${index} is not an object`)
    }
    const rawIndex = candidate.index ?? index
    const normalizedIndex = typeof rawIndex === 'string'
      ? decimal(rawIndex, `${label} sidecar index`)
      : rawIndex
    if (!Number.isSafeInteger(normalizedIndex) || normalizedIndex < 0) {
      fail('INVALID_PROVIDER_RESPONSE', `${label} sidecar index is invalid`)
    }
    return Object.freeze({ ...candidate, index: normalizedIndex })
  })
}

async function readSidecars(source, accounting, root) {
  const current = await beacon(
    source,
    accounting,
    `/eth/v1/beacon/blobs/${root}`,
    'current blob endpoint',
    { allowUnsupported: true },
  )
  if (current !== null && Array.isArray(current)
    && current.every((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate))) {
    return { endpoint: 'current', sidecars: normalizeSidecarArray(current, 'current blob endpoint') }
  }
  if (current !== null && (!Array.isArray(current)
    || !current.every((candidate) => typeof candidate === 'string' && /^0x(?:[0-9a-f]{2})+$/iu.test(candidate)))) {
    fail('INVALID_PROVIDER_RESPONSE', 'current blob endpoint returned an unsupported data shape')
  }
  const legacy = await beacon(
    source,
    accounting,
    `/eth/v1/beacon/blob_sidecars/${root}`,
    'legacy blob sidecar endpoint',
  )
  return {
    endpoint: current === null ? 'legacy' : 'legacy_after_blobs_only',
    sidecars: normalizeSidecarArray(legacy, 'legacy blob sidecar endpoint'),
  }
}

async function observeBeaconSource(source, accounting, { slot, blockHash }) {
  const headerData = await beacon(source, accounting, `/eth/v1/beacon/headers/${slot}`, 'inclusion header')
  const root = hex(headerData?.root, 32, 'inclusion header root')
  const canonical = headerData?.canonical
  if (typeof canonical !== 'boolean') fail('INVALID_PROVIDER_RESPONSE', 'inclusion header omitted canonical')
  const headerSlot = decimal(headerData?.header?.message?.slot, 'inclusion header slot')
  if (headerSlot !== slot) fail('INVALID_PROVIDER_RESPONSE', 'inclusion header returned another slot')

  const blockData = await beacon(source, accounting, `/eth/v2/beacon/blocks/${root}`, 'beacon block')
  const observedBlockHash = hex(executionBlockHash(blockData), 32, 'beacon execution block hash')
  if (observedBlockHash !== blockHash) {
    fail('EXECUTION_BEACON_MISMATCH', 'beacon block does not contain the execution block')
  }

  const [headData, finalizedData] = await Promise.all([
    beacon(source, accounting, '/eth/v1/beacon/headers/head', 'head header'),
    beacon(source, accounting, '/eth/v1/beacon/headers/finalized', 'finalized header'),
  ])
  const sidecars = await readSidecars(source, accounting, root)
  const headSlot = decimal(headData?.header?.message?.slot, 'head slot')
  const finalizedSlot = decimal(finalizedData?.header?.message?.slot, 'finalized slot')
  if (finalizedSlot > headSlot) fail('INVALID_PROVIDER_RESPONSE', 'finalized slot exceeds head slot')
  return Object.freeze({
    providerId: source.provider.providerId,
    slot,
    root,
    canonical,
    headSlot,
    finalizedSlot,
    endpoint: sidecars.endpoint,
    sidecars: sidecars.sidecars,
  })
}

async function sidecarFingerprint(observation) {
  const items = []
  for (const candidate of observation.sidecars) {
    const commitment = hex(candidate.kzg_commitment ?? candidate.kzgCommitment ?? candidate.commitment, 48, 'sidecar commitment')
    const proof = hex(candidate.kzg_proof ?? candidate.kzgProof, 48, 'sidecar proof')
    const blob = candidate.blob
    if (typeof blob !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(blob)) {
      fail('INVALID_PROVIDER_RESPONSE', 'sidecar blob is not byte hex')
    }
    if ((blob.length - 2) / 2 !== BLOB_BYTES) fail('INVALID_PROVIDER_RESPONSE', 'sidecar blob has the wrong byte length')
    items.push(`${commitment}:${proof}:${await sha256Hex(blobToBytes(blob))}`)
  }
  return items.sort().join('|')
}

function blobToBytes(value) {
  const hexValue = value.slice(2)
  const bytes = new Uint8Array(hexValue.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hexValue.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes
}

async function assertProviderAgreement(observations) {
  if (observations.length < 2) return
  const [first, second] = observations
  const firstFingerprint = await sidecarFingerprint(first)
  const secondFingerprint = await sidecarFingerprint(second)
  if (first.root !== second.root
    || first.canonical !== second.canonical
    || firstFingerprint !== secondFingerprint) {
    fail('PROVIDER_DISAGREEMENT', 'beacon providers disagree about inclusion or sidecar bytes')
  }
}

function replayCacheKey({ slot, root, hashes }) {
  return `blobmail:sepolia-sidecars:v1:${SEPOLIA_CHAIN_ID}:${SEPOLIA_GENESIS.validatorsRoot}:${slot}:${root}:${hashes.join(',')}`
}

function normalizeKzg(kzg) {
  if (!kzg || typeof kzg.verifyBlobKZGProof !== 'function') {
    fail('KZG_UNAVAILABLE', 'a reviewed KZG verifier is required')
  }
  return kzg
}

function verifyKzg(matches, kzg, completedEvidence) {
  for (const match of matches) {
    if (typeof match.kzgProof !== 'string' || !HEX_48.test(match.kzgProof)) {
      fail('INVALID_KZG_PROOF', 'sidecar KZG proof is not 48-byte hex', completedEvidence)
    }
    const proof = match.kzgProof.toLowerCase()
    let valid = false
    try {
      valid = kzg.verifyBlobKZGProof(bytesToHex(match.blob), match.commitment, proof)
    } catch {
      fail('INVALID_KZG_PROOF', 'KZG proof verification rejected a sidecar', completedEvidence)
    }
    if (valid !== true) fail('INVALID_KZG_PROOF', 'KZG proof verification failed', completedEvidence)
  }
}

export async function replaySepoliaBlobTransaction({
  profile,
  txHash,
  manifest,
  requestJson,
  beaconSources,
  kzg,
  cache = null,
  now = () => new Date().toISOString(),
} = {}) {
  assertProfile(profile)
  const normalizedTxHash = hex(txHash, 32, 'transaction hash')
  const normalizedManifest = normalizeManifest(manifest)
  if (typeof requestJson !== 'function') fail('INVALID_REQUEST_ADAPTER', 'requestJson must be a function')
  const sources = normalizeBeaconSources(profile, requestJson, beaconSources)
  const verifier = normalizeKzg(kzg)
  if (cache !== null && (typeof cache?.get !== 'function' || typeof cache?.set !== 'function')) {
    fail('INVALID_CACHE', 'cache must expose bounded get and set methods')
  }
  const accounting = { requests: 0 }
  const executionSource = { requestJson }
  const completedEvidence = []

  const identities = await Promise.all([
    rpc(executionSource, profile.providers.execution, accounting, 1, 'eth_chainId'),
    ...sources.map((source) => beacon(source, accounting, '/eth/v1/beacon/genesis', 'beacon genesis')),
  ])
  if (hexQuantity(identities[0], 'chainId') !== SEPOLIA_CHAIN_ID) {
    fail('CHAIN_ID_MISMATCH', 'execution provider returned another chain')
  }
  for (const genesis of identities.slice(1)) {
    if (String(genesis?.genesis_time) !== SEPOLIA_GENESIS.time
      || String(genesis?.genesis_fork_version).toLowerCase() !== SEPOLIA_GENESIS.forkVersion
      || String(genesis?.genesis_validators_root).toLowerCase() !== SEPOLIA_GENESIS.validatorsRoot) {
      fail('BEACON_GENESIS_MISMATCH', 'beacon provider returned another genesis identity')
    }
  }

  const transaction = await rpc(
    executionSource,
    profile.providers.execution,
    accounting,
    2,
    'eth_getTransactionByHash',
    [normalizedTxHash],
  )
  if (!transaction || typeof transaction !== 'object') fail('TRANSACTION_NOT_FOUND', 'blob transaction was not found')
  if (hex(transaction.hash, 32, 'transaction hash') !== normalizedTxHash) {
    fail('INVALID_PROVIDER_RESPONSE', 'transaction hash does not match the request')
  }
  const type = hexQuantity(transaction.type, 'transaction type')
  if (type !== 3) fail('NOT_BLOB_TRANSACTION', 'transaction is not EIP-4844 type 3')
  const blockHash = hex(transaction.blockHash, 32, 'transaction blockHash')
  const blockNumber = hexQuantity(transaction.blockNumber, 'transaction blockNumber')
  if (!Array.isArray(transaction.blobVersionedHashes)) {
    fail('INVALID_PROVIDER_RESPONSE', 'blob transaction omitted versioned hashes')
  }
  const transactionHashes = transaction.blobVersionedHashes.map((value, index) => hex(value, 32, `transaction hash ${index}`))
  if (transactionHashes.length !== normalizedManifest.blobVersionedHashes.length
    || transactionHashes.some((value, index) => value !== normalizedManifest.blobVersionedHashes[index])) {
    fail('TRANSACTION_MANIFEST_MISMATCH', 'transaction versioned hashes do not match the manifest')
  }

  const [block, canonicalBlock] = await Promise.all([
    rpc(executionSource, profile.providers.execution, accounting, 3, 'eth_getBlockByHash', [blockHash, false]),
    rpc(executionSource, profile.providers.execution, accounting, 4, 'eth_getBlockByNumber', [transaction.blockNumber, false]),
  ])
  if (!block || !canonicalBlock || hex(block.hash, 32, 'block hash') !== blockHash
    || hex(canonicalBlock.hash, 32, 'canonical block hash') !== blockHash) {
    fail('REORGED_BLOCK', 'execution block is no longer canonical')
  }
  if (hexQuantity(block.number, 'block number') !== blockNumber) {
    fail('INVALID_PROVIDER_RESPONSE', 'execution block number does not match the transaction')
  }
  const timestamp = hexQuantity(block.timestamp, 'block timestamp')
  const genesisTime = Number(SEPOLIA_GENESIS.time)
  if (timestamp < genesisTime || (timestamp - genesisTime) % 12 !== 0) {
    fail('INVALID_PROVIDER_RESPONSE', 'execution timestamp does not resolve to a canonical beacon slot')
  }
  const slot = (timestamp - genesisTime) / 12

  const observations = await Promise.all(sources.map((source) => observeBeaconSource(source, accounting, {
    slot,
    blockHash,
  })))
  await assertProviderAgreement(observations)
  const observation = observations[0]
  if (!observation.canonical || (normalizedManifest.expectedBeaconRoot
    && normalizedManifest.expectedBeaconRoot !== observation.root)) {
    fail('REORGED_BLOCK', 'beacon inclusion is not canonical or changed roots')
  }
  completedEvidence.push(evidence(SIDECAR_EVIDENCE_STATES.BLOB_TRANSACTION_INCLUDED, {
    chainId: SEPOLIA_CHAIN_ID,
    transactionHash: normalizedTxHash,
    blockNumber,
    blockHash,
    slot,
    beaconRoot: observation.root,
    canonical: true,
    headSlot: observation.headSlot,
    finalizedSlot: observation.finalizedSlot,
    finality: observation.finalizedSlot >= slot ? 'finalized_checkpoint_at_or_after_inclusion' : 'not_finalized_at_observation',
    providerIds: observations.map(({ providerId }) => providerId),
  }))

  const key = replayCacheKey({ slot, root: observation.root, hashes: normalizedManifest.blobVersionedHashes })
  let matches = cache?.get(key) ?? null
  const cacheHit = matches !== null
  if (!matches) {
    try {
      matches = await selectSidecarsByVersionedHash(
        normalizedManifest.blobVersionedHashes,
        observation.sidecars,
        { maxBlobs: SEPOLIA_SIDECAR_LIMITS.maxBlobs, maxSidecars: SEPOLIA_SIDECAR_LIMITS.maxBlobs * 4 },
      )
    } catch (error) {
      fail(error?.code ?? 'INVALID_SIDECARS', 'sidecar selection failed', completedEvidence)
    }
    cache?.set(key, matches)
  }
  completedEvidence.push(evidence(SIDECAR_EVIDENCE_STATES.SIDECARS_MATCHED, {
    blobCount: matches.length,
    versionedHashes: matches.map(({ versionedHash }) => versionedHash),
    commitmentHashVerified: true,
    cacheHit,
    cacheKey: key,
  }))

  verifyKzg(matches, verifier, completedEvidence)
  completedEvidence.push(evidence(SIDECAR_EVIDENCE_STATES.KZG_PROOF_VERIFIED, {
    blobCount: matches.length,
    implementation: 'kzg-wasm@1.0.0/c-kzg-4844',
  }))

  let payload
  let batch
  try {
    if (normalizedManifest.kind === 'declared-segment') {
      batch = await decodeBlobMailBatchFromDeclaredSegment(matches[0].blob, {
        startFE: normalizedManifest.startFE,
        endFE: normalizedManifest.endFE,
      })
      payload = batch.batchBytes
    } else {
      payload = decodePayloadFromBlobs(
        matches.map(({ blob }) => blob),
        normalizedManifest.payloadBytes,
        { maxBlobs: SEPOLIA_SIDECAR_LIMITS.maxBlobs },
      )
    }
  } catch {
    fail('BATCH_RECONSTRUCTION_FAILED', 'blob field elements could not be reconstructed', completedEvidence)
  }
  completedEvidence.push(evidence(SIDECAR_EVIDENCE_STATES.BATCH_RECONSTRUCTED, {
    payloadBytes: payload.byteLength,
    encoding: '31-byte-data-per-field-element',
  }))

  const payloadSha256 = await sha256Hex(payload)
  if (normalizedManifest.payloadSha256 !== null && payloadSha256 !== normalizedManifest.payloadSha256) {
    fail('PAYLOAD_SHA256_MISMATCH', 'reconstructed payload digest does not match the manifest', completedEvidence)
  }
  if (normalizedManifest.payloadSha256 !== null) {
    completedEvidence.push(evidence(SIDECAR_EVIDENCE_STATES.PAYLOAD_SHA256_VERIFIED, { payloadSha256 }))
  }

  if (!batch) {
    try {
      batch = await parseBatch(payload)
    } catch {
      fail('INVALID_BLOBMAIL_BATCH', 'verified payload is not a canonical BlobMail batch', completedEvidence)
    }
  }
  if (normalizedManifest.batchId && batch.batchId !== normalizedManifest.batchId) {
    fail('BATCH_ID_MISMATCH', 'parsed batch ID does not match the manifest', completedEvidence)
  }

  return Object.freeze({
    schema: 'blobmail.sepolia-sidecar-replay.v1',
    generatedAt: now(),
    result: 'PASS',
    provenance: Object.freeze({
      chainId: SEPOLIA_CHAIN_ID,
      genesisValidatorsRoot: SEPOLIA_GENESIS.validatorsRoot,
      transactionHash: normalizedTxHash,
      blockNumber,
      blockHash,
      slot,
      beaconRoot: observation.root,
      providerIds: observations.map(({ providerId }) => providerId),
      endpoints: observations.map(({ endpoint }) => endpoint),
      headSlots: observations.map(({ headSlot }) => headSlot),
      finalizedSlots: observations.map(({ finalizedSlot }) => finalizedSlot),
    }),
    payload: payload.slice(),
    payloadSha256,
    batchId: batch.batchId,
    entryIds: Object.freeze([...batch.entryIds]),
    commitments: Object.freeze(matches.map(({ commitment }) => commitment)),
    proofs: Object.freeze(matches.map(({ kzgProof }) => String(kzgProof).toLowerCase())),
    versionedHashes: Object.freeze(matches.map(({ versionedHash }) => versionedHash)),
    evidence: Object.freeze(completedEvidence),
    accounting: Object.freeze({
      requestCount: accounting.requests,
      providerCount: 1 + sources.length,
      blobCount: matches.length,
      blobBytes: matches.length * BLOB_BYTES,
      cacheHit,
    }),
  })
}
