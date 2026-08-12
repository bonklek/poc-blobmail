import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import { createNetworkProfile } from '../src/network/index.js'
import { boundedHttpsJson } from '../src/network/node-https.js'
import { deriveIdentity, scanBatch } from '../src/protocol/index.js'
import { loadNodeKzg, replaySepoliaBlobTransaction } from '../src/sidecars/index.js'

const RECEIPT_PATH = new URL('../reports/sepolia-mvp-live-acceptance.json', import.meta.url)

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

const receipt = JSON.parse(await readFile(RECEIPT_PATH, 'utf8'))
const profile = createNetworkProfile({
  BLOBMAIL_NETWORK_MODE: 'readonly',
  BLOBMAIL_NETWORK: 'sepolia',
  BLOBMAIL_SEPOLIA_EXECUTION_RPC_URL: 'https://sepolia.gateway.tenderly.co',
  BLOBMAIL_SEPOLIA_BEACON_RPC_URL: 'https://lodestar-sepolia.chainsafe.io',
  BLOBMAIL_SEPOLIA_ALLOWED_HOSTS: 'sepolia.gateway.tenderly.co,lodestar-sepolia.chainsafe.io',
})
const manifest = {
  blobVersionedHashes: [receipt.declaration.versionedHash],
  expectedBeaconRoot: receipt.receiver.beaconRoot,
  startFE: receipt.declaration.startFE,
  endFE: receipt.declaration.endFE,
  payloadSha256: receipt.declaration.payloadSha256,
  batchId: receipt.declaration.batchId,
}

const kzg = await loadNodeKzg()
let replay
let attemptCount = 0
for (; attemptCount < 2; attemptCount += 1) {
  try {
    replay = await replaySepoliaBlobTransaction({
      profile,
      txHash: receipt.publication.transactionHash,
      manifest,
      requestJson: boundedHttpsJson,
      kzg,
    })
    break
  } catch (error) {
    if (attemptCount === 1 || error?.code !== 'PROVIDER_REQUEST_FAILED') throw error
  }
}
const intended = await scanBatch({
  batchBytes: replay.payload,
  recipientIdentity: await deriveIdentity(new Uint8Array(32).fill(42)),
})
const unrelated = await scanBatch({
  batchBytes: replay.payload,
  recipientIdentity: await deriveIdentity(new Uint8Array(32).fill(44)),
})
const finalizedSlot = Math.min(...replay.provenance.finalizedSlots)

invariant(finalizedSlot >= replay.provenance.slot, 'inclusion has not reached a finalized checkpoint')
invariant(intended.matches.length === 1, 'intended acceptance identity did not decrypt exactly one entry')
invariant(intended.notForRecipient === 0, 'intended acceptance identity skipped an entry')
invariant(unrelated.matches.length === 0, 'unrelated identity decrypted an acceptance entry')
invariant(unrelated.notForRecipient === 1, 'unrelated identity did not reject exactly one entry')
invariant(intended.matches[0].plaintextBytes.byteLength === receipt.receiver.plaintextUtf8Bytes, 'plaintext byte count changed')
invariant(sha256(intended.matches[0].plaintextBytes) === receipt.receiver.plaintextSha256, 'plaintext digest changed')

console.log(JSON.stringify({
  result: 'PASS',
  attemptCount: attemptCount + 1,
  generatedAt: replay.generatedAt,
  transactionHash: replay.provenance.transactionHash,
  blockHash: replay.provenance.blockHash,
  slot: replay.provenance.slot,
  beaconRoot: replay.provenance.beaconRoot,
  observedHeadSlot: Math.min(...replay.provenance.headSlots),
  observedFinalizedSlot: finalizedSlot,
  requestCount: replay.accounting.requestCount,
  recipientMatches: intended.matches.length,
  notForRecipient: unrelated.notForRecipient,
  kzgProofVerified: replay.evidence.some(({ state }) => state === 'KZG_PROOF_VERIFIED'),
  batchReconstructed: replay.evidence.some(({ state }) => state === 'BATCH_RECONSTRUCTED'),
}, null, 2))
