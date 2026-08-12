import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SEPOLIA_GENESIS,
  createNetworkProfile,
} from '../src/network/index.js'
import {
  SIDECAR_EVIDENCE_STATES,
  SidecarReplayError,
  createBoundedSidecarCache,
  loadNodeKzg,
  replaySepoliaBlobTransaction,
} from '../src/sidecars/index.js'
import {
  bytesToHex,
  commitmentToVersionedHash,
  encodePayloadToBlobs,
  sha256Hex,
} from '../src/transport/index.js'
import { deriveIdentity, encryptText, packBatch } from '../src/protocol/index.js'

const PROFILE = createNetworkProfile({
  BLOBMAIL_NETWORK_MODE: 'readonly',
  BLOBMAIL_NETWORK: 'sepolia',
  BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL: 'https://sepolia.drpc.org',
  BLOBMAIL_SEPOLIA_BEACON_RPC_URL: 'https://ethereum-sepolia-beacon-api.publicnode.com',
})
const SECOND_BEACON = Object.freeze({
  role: 'beacon',
  providerId: 'blobmail-sepolia-v0:beacon:second.example.org',
  hostname: 'second.example.org',
  origin: 'https://second.example.org',
})

const TX_HASH = `0x${'11'.repeat(32)}`
const BLOCK_HASH = `0x${'22'.repeat(32)}`
const BEACON_ROOT = `0x${'33'.repeat(32)}`
const OTHER_ROOT = `0x${'44'.repeat(32)}`
const SLOT = 8_800_000
const BLOCK_NUMBER = 9_900_000

let kzg
let fixture

function rpc(id, result, statusCode = 200) {
  return { statusCode, body: { jsonrpc: '2.0', id, result } }
}

function beacon(data, statusCode = 200) {
  return { statusCode, body: { data } }
}

function requester({
  chainId = '0xaa36a7',
  canonicalBlockHash = BLOCK_HASH,
  beaconRoot = BEACON_ROOT,
  canonical = true,
  finalizedSlot = SLOT + 32,
  sidecars = fixture.sidecars,
  transactionHashes = fixture.manifest.blobVersionedHashes,
  currentStatus = 200,
} = {}) {
  const calls = []
  const requestJson = async (spec) => {
    calls.push({ providerId: spec.providerId, method: spec.method, pathname: spec.url.pathname })
    if (spec.role === 'execution') {
      switch (spec.body.method) {
        case 'eth_chainId': return rpc(spec.body.id, chainId)
        case 'eth_getTransactionByHash':
          return rpc(spec.body.id, {
            hash: TX_HASH,
            type: '0x3',
            blockHash: BLOCK_HASH,
            blockNumber: `0x${BLOCK_NUMBER.toString(16)}`,
            blobVersionedHashes: transactionHashes,
          })
        case 'eth_getBlockByHash':
          return rpc(spec.body.id, {
            hash: BLOCK_HASH,
            number: `0x${BLOCK_NUMBER.toString(16)}`,
            timestamp: `0x${(Number(SEPOLIA_GENESIS.time) + SLOT * 12).toString(16)}`,
          })
        case 'eth_getBlockByNumber':
          return rpc(spec.body.id, { hash: canonicalBlockHash })
        default: throw new Error(`unexpected execution method ${spec.body.method}`)
      }
    }

    switch (spec.url.pathname) {
      case '/eth/v1/beacon/genesis':
        return beacon({
          genesis_time: SEPOLIA_GENESIS.time,
          genesis_fork_version: SEPOLIA_GENESIS.forkVersion,
          genesis_validators_root: SEPOLIA_GENESIS.validatorsRoot,
        })
      case `/eth/v1/beacon/headers/${SLOT}`:
        return beacon({
          root: beaconRoot,
          canonical,
          header: { message: { slot: String(SLOT) } },
        })
      case `/eth/v2/beacon/blocks/${beaconRoot}`:
        return beacon({ message: { body: { execution_payload: { block_hash: BLOCK_HASH } } } })
      case '/eth/v1/beacon/headers/head':
        return beacon({ header: { message: { slot: String(SLOT + 64) } } })
      case '/eth/v1/beacon/headers/finalized':
        return beacon({ header: { message: { slot: String(finalizedSlot) } } })
      case `/eth/v1/beacon/blobs/${beaconRoot}`:
        return currentStatus === 200 ? beacon(sidecars) : { statusCode: currentStatus, body: { code: currentStatus } }
      case `/eth/v1/beacon/blob_sidecars/${beaconRoot}`:
        return beacon(sidecars)
      default: throw new Error(`unexpected beacon path ${spec.url.pathname}`)
    }
  }
  return { requestJson, calls }
}

async function makeSidecar(blob) {
  const blobHex = bytesToHex(blob)
  const commitment = kzg.blobToKZGCommitment(blobHex).toLowerCase()
  const proof = kzg.computeBlobKZGProof(blobHex, commitment).toLowerCase()
  return {
    index: '0',
    blob: blobHex,
    kzg_commitment: commitment,
    kzg_proof: proof,
    versionedHash: await commitmentToVersionedHash(commitment),
  }
}

test.before(async () => {
  kzg = await loadNodeKzg()
  const recipient = await deriveIdentity(new Uint8Array(32).fill(2))
  const encrypted = await encryptText({
    text: 'Sepolia sidecar replay fixture',
    recipientIdentity: recipient,
    ephemeralSeed: new Uint8Array(32).fill(3),
  })
  const batch = await packBatch([encrypted.entryBytes])
  const [blob] = encodePayloadToBlobs(batch.batchBytes, { maxBlobs: 1 })
  const sidecar = await makeSidecar(blob)
  fixture = {
    sidecars: [sidecar],
    manifest: {
      blobVersionedHashes: [sidecar.versionedHash],
      payloadBytes: batch.batchBytes.byteLength,
      payloadSha256: await sha256Hex(batch.batchBytes),
      batchId: batch.batchId,
      expectedBeaconRoot: BEACON_ROOT,
    },
    batch,
  }
})

test('replays a canonical Sepolia blob into a verified BlobMail batch', async () => {
  const network = requester()
  const result = await replaySepoliaBlobTransaction({
    profile: PROFILE,
    txHash: TX_HASH,
    manifest: fixture.manifest,
    requestJson: network.requestJson,
    kzg,
    now: () => '2026-08-10T00:00:00.000Z',
  })

  assert.equal(result.result, 'PASS')
  assert.equal(result.batchId, fixture.batch.batchId)
  assert.equal(result.provenance.slot, SLOT)
  assert.equal(result.provenance.beaconRoot, BEACON_ROOT)
  assert.deepEqual(result.evidence.map(({ state }) => state), Object.values(SIDECAR_EVIDENCE_STATES))
  assert.equal(result.evidence[0].details.finality, 'finalized_checkpoint_at_or_after_inclusion')
  assert.equal(result.accounting.requestCount, 10)
  assert.ok(network.calls.every(({ method }) => method === 'GET' || method === 'POST'))
})

test('accepts reordered provider sidecars but rejects missing and duplicate matches', async () => {
  const unrelatedBlob = new Uint8Array(fixture.sidecars[0].blob.length / 2 - 1)
  const unrelated = await makeSidecar(unrelatedBlob)
  const reordered = requester({ sidecars: [unrelated, ...fixture.sidecars] })
  const result = await replaySepoliaBlobTransaction({
    profile: PROFILE,
    txHash: TX_HASH,
    manifest: fixture.manifest,
    requestJson: reordered.requestJson,
    kzg,
  })
  assert.equal(result.result, 'PASS')

  for (const [sidecars, code] of [
    [[], 'MISSING_SIDECAR'],
    [[...fixture.sidecars, ...fixture.sidecars], 'DUPLICATE_SIDECAR'],
  ]) {
    const network = requester({ sidecars })
    await assert.rejects(
      replaySepoliaBlobTransaction({
        profile: PROFILE,
        txHash: TX_HASH,
        manifest: fixture.manifest,
        requestJson: network.requestJson,
        kzg,
      }),
      (error) => error instanceof SidecarReplayError
        && error.code === code
        && error.evidence.length === 1,
    )
  }
})

test('invalid KZG stops the evidence ladder before reconstruction', async () => {
  const invalid = structuredClone(fixture.sidecars[0])
  invalid.kzg_proof = `${invalid.kzg_proof.slice(0, -2)}00`
  const network = requester({ sidecars: [invalid] })
  await assert.rejects(
    replaySepoliaBlobTransaction({
      profile: PROFILE,
      txHash: TX_HASH,
      manifest: fixture.manifest,
      requestJson: network.requestJson,
      kzg,
    }),
    (error) => error instanceof SidecarReplayError
      && error.code === 'INVALID_KZG_PROOF'
      && error.evidence.map(({ state }) => state).join(',') === 'BLOB_TRANSACTION_INCLUDED,SIDECARS_MATCHED',
  )
})

test('truncated and oversized sidecar inputs fail within explicit bounds', async () => {
  const truncated = { ...fixture.sidecars[0], blob: fixture.sidecars[0].blob.slice(0, -2) }
  const network = requester({ sidecars: [truncated] })
  await assert.rejects(
    replaySepoliaBlobTransaction({
      profile: PROFILE,
      txHash: TX_HASH,
      manifest: fixture.manifest,
      requestJson: network.requestJson,
      kzg,
    }),
    (error) => error instanceof SidecarReplayError
      && error.code === 'INVALID_SIDECARS'
      && error.evidence.length === 1,
  )

  await assert.rejects(
    replaySepoliaBlobTransaction({
      profile: PROFILE,
      txHash: TX_HASH,
      manifest: {
        ...fixture.manifest,
        blobVersionedHashes: Array.from({ length: 7 }, (_, index) => `0x${String(index).padStart(64, '0')}`),
      },
      requestJson: async () => { throw new Error('must not request') },
      kzg,
    }),
    (error) => error instanceof SidecarReplayError && error.code === 'INVALID_MANIFEST',
  )
})

test('a valid proof over noncanonical field elements fails after KZG but before digest evidence', async () => {
  const blob = Uint8Array.from(Buffer.from(fixture.sidecars[0].blob.slice(2), 'hex'))
  blob[0] = 1
  const corrupt = await makeSidecar(blob)
  const network = requester({ sidecars: [corrupt], transactionHashes: [corrupt.versionedHash] })
  const manifest = {
    ...fixture.manifest,
    blobVersionedHashes: [corrupt.versionedHash],
    expectedBeaconRoot: BEACON_ROOT,
  }
  await assert.rejects(
    replaySepoliaBlobTransaction({
      profile: PROFILE,
      txHash: TX_HASH,
      manifest,
      requestJson: network.requestJson,
      kzg,
    }),
    (error) => error instanceof SidecarReplayError
      && error.code === 'BATCH_RECONSTRUCTION_FAILED'
      && error.evidence.at(-1).state === 'KZG_PROOF_VERIFIED',
  )
})

test('corrupt canonical blob bytes fail payload SHA-256 before batch parsing', async () => {
  const blob = Uint8Array.from(Buffer.from(fixture.sidecars[0].blob.slice(2), 'hex'))
  blob[2] ^= 1
  const corrupt = await makeSidecar(blob)
  const network = requester({ sidecars: [corrupt], transactionHashes: [corrupt.versionedHash] })
  const manifest = {
    ...fixture.manifest,
    blobVersionedHashes: [corrupt.versionedHash],
    expectedBeaconRoot: BEACON_ROOT,
  }
  await assert.rejects(
    replaySepoliaBlobTransaction({
      profile: PROFILE,
      txHash: TX_HASH,
      manifest,
      requestJson: network.requestJson,
      kzg,
    }),
    (error) => error instanceof SidecarReplayError
      && error.code === 'PAYLOAD_SHA256_MISMATCH'
      && error.evidence.at(-1).state === 'BATCH_RECONSTRUCTED',
  )
})

test('wrong-chain and reorg observations fail before inclusion evidence', async () => {
  for (const [options, code] of [
    [{ chainId: '0x1' }, 'CHAIN_ID_MISMATCH'],
    [{ canonicalBlockHash: OTHER_ROOT }, 'REORGED_BLOCK'],
    [{ canonical: false }, 'REORGED_BLOCK'],
  ]) {
    const network = requester(options)
    await assert.rejects(
      replaySepoliaBlobTransaction({
        profile: PROFILE,
        txHash: TX_HASH,
        manifest: fixture.manifest,
        requestJson: network.requestJson,
        kzg,
      }),
      (error) => error instanceof SidecarReplayError && error.code === code && error.evidence.length === 0,
    )
  }
})

test('non-finalized inclusion stays explicit without blocking verified reconstruction', async () => {
  const network = requester({ finalizedSlot: SLOT - 1 })
  const result = await replaySepoliaBlobTransaction({
    profile: PROFILE,
    txHash: TX_HASH,
    manifest: fixture.manifest,
    requestJson: network.requestJson,
    kzg,
  })
  assert.equal(result.evidence[0].details.finality, 'not_finalized_at_observation')
})

test('legacy sidecar endpoint fallback remains explicit in provenance', async () => {
  const network = requester({ currentStatus: 404 })
  const result = await replaySepoliaBlobTransaction({
    profile: PROFILE,
    txHash: TX_HASH,
    manifest: fixture.manifest,
    requestJson: network.requestJson,
    kzg,
  })
  assert.deepEqual(result.provenance.endpoints, ['legacy'])
  assert.equal(result.accounting.requestCount, 11)
})

test('two beacon providers must agree on roots and sidecar bytes', async () => {
  const primary = requester()
  const secondary = requester({ beaconRoot: OTHER_ROOT })
  await assert.rejects(
    replaySepoliaBlobTransaction({
      profile: PROFILE,
      txHash: TX_HASH,
      manifest: { ...fixture.manifest, expectedBeaconRoot: undefined },
      requestJson: primary.requestJson,
      beaconSources: [
        { provider: PROFILE.providers.beacon, requestJson: primary.requestJson },
        { provider: SECOND_BEACON, requestJson: secondary.requestJson },
      ],
      kzg,
    }),
    (error) => error instanceof SidecarReplayError
      && error.code === 'PROVIDER_DISAGREEMENT'
      && error.evidence.length === 0,
  )
})

test('bounded cache is deterministic, evicts oldest data, and never skips KZG verification', async () => {
  const cache = createBoundedSidecarCache({ maxEntries: 1, maxBytes: 200_000 })
  const network = requester()
  const first = await replaySepoliaBlobTransaction({
    profile: PROFILE,
    txHash: TX_HASH,
    manifest: fixture.manifest,
    requestJson: network.requestJson,
    kzg,
    cache,
  })
  const second = await replaySepoliaBlobTransaction({
    profile: PROFILE,
    txHash: TX_HASH,
    manifest: fixture.manifest,
    requestJson: network.requestJson,
    kzg,
    cache,
  })
  assert.equal(first.accounting.cacheHit, false)
  assert.equal(second.accounting.cacheHit, true)
  assert.equal(second.evidence.some(({ state }) => state === 'KZG_PROOF_VERIFIED'), true)
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 131232, maxEntries: 1, maxBytes: 200000 })
})

test('independent all-zero c-kzg vector has the expected point-at-infinity commitment and proof', () => {
  const blob = `0x${'00'.repeat(131_072)}`
  const pointAtInfinity = `0xC0${'00'.repeat(47)}`
  const commitment = kzg.blobToKZGCommitment(blob)
  const proof = kzg.computeBlobKZGProof(blob, commitment)
  assert.equal(commitment, pointAtInfinity)
  assert.equal(proof, pointAtInfinity)
  assert.equal(kzg.verifyBlobKZGProof(blob, commitment, proof), true)
})
