import { scanBatch } from '../protocol/index.js'
import { discoverBlobMailSegments } from '../segments/index.js'
import { replaySepoliaBlobTransaction } from '../sidecars/replay.js'

export const MAILBOX_RECEIVE_LIMITS = Object.freeze({
  maxExistingEntryIds: 512,
  maxDeclarationsPerRefresh: 16,
  maxMessagesPerRefresh: 64,
})

export class MailboxReceiveError extends Error {
  constructor(code, message, cause) {
    super(message)
    this.name = 'MailboxReceiveError'
    this.code = code
    this.cause = cause
  }
}

function fail(code, message, cause) {
  throw new MailboxReceiveError(code, message, cause)
}

function normalizeIds(values) {
  if (!Array.isArray(values) || values.length > MAILBOX_RECEIVE_LIMITS.maxExistingEntryIds) {
    fail('INVALID_DEDUPE_SET', `existingEntryIds must contain at most ${MAILBOX_RECEIVE_LIMITS.maxExistingEntryIds} items`)
  }
  const ids = values.map((value) => String(value))
  if (ids.some((value) => !/^[0-9a-f]{64}$/u.test(value))) fail('INVALID_DEDUPE_SET', 'entry IDs must be lowercase 32-byte hex')
  return new Set(ids)
}

export async function refreshMailbox({
  requestRpc,
  requestJson,
  profile,
  kzg,
  identity,
  fromBlock,
  anchor = null,
  existingEntryIds = [],
  beaconSources,
  cache = null,
  now = () => new Date().toISOString(),
  discover = discoverBlobMailSegments,
  replay = replaySepoliaBlobTransaction,
} = {}) {
  if (!identity?.privateKey) fail('INVALID_IDENTITY', 'an unlocked recipient identity is required')
  const seen = normalizeIds(existingEntryIds)
  let discovery
  try {
    discovery = await discover({ requestRpc, fromBlock, anchor })
  } catch (cause) {
    fail(cause?.code ?? 'DISCOVERY_FAILED', 'segment discovery failed without advancing the mailbox cursor', cause)
  }
  if (discovery.declarations.length > MAILBOX_RECEIVE_LIMITS.maxDeclarationsPerRefresh) {
    fail('DECLARATION_LIMIT_EXCEEDED', `one refresh accepts at most ${MAILBOX_RECEIVE_LIMITS.maxDeclarationsPerRefresh} declarations`)
  }

  const messages = []
  const batches = []
  for (const declaration of discovery.declarations) {
    let verified
    try {
      verified = await replay({
        profile,
        txHash: declaration.transactionHash,
        manifest: {
          blobVersionedHashes: [declaration.versionedHash],
          startFE: declaration.startFE,
          endFE: declaration.endFE,
        },
        requestJson,
        beaconSources,
        kzg,
        cache,
        now,
      })
    } catch (cause) {
      fail(cause?.code ?? 'SIDECAR_REPLAY_FAILED', 'a discovered segment failed verification; cursor was not advanced', cause)
    }
    let scanned
    try {
      scanned = await scanBatch({ batchBytes: verified.payload, recipientIdentity: identity })
    } catch (cause) {
      fail(cause?.code ?? 'RECIPIENT_SCAN_FAILED', 'a verified batch could not be scanned', cause)
    }
    batches.push(Object.freeze({
      batchId: verified.batchId,
      transactionHash: declaration.transactionHash,
      blockNumber: declaration.blockNumber,
      matches: scanned.matches.length,
      notForRecipient: scanned.notForRecipient,
    }))
    for (const match of scanned.matches) {
      if (seen.has(match.entryId)) continue
      if (messages.length >= MAILBOX_RECEIVE_LIMITS.maxMessagesPerRefresh) {
        fail('MESSAGE_LIMIT_EXCEEDED', `one refresh accepts at most ${MAILBOX_RECEIVE_LIMITS.maxMessagesPerRefresh} messages`)
      }
      seen.add(match.entryId)
      messages.push(Object.freeze({
        entryId: match.entryId,
        batchId: verified.batchId,
        body: match.text,
        receivedAt: now(),
        transactionHash: declaration.transactionHash,
        blockNumber: declaration.blockNumber,
        blockHash: declaration.blockHash,
        versionedHash: declaration.versionedHash,
        evidence: Object.freeze(verified.evidence.map(({ state }) => state)),
      }))
    }
  }

  return Object.freeze({
    messages: Object.freeze(messages),
    batches: Object.freeze(batches),
    cursor: Object.freeze({ nextBlock: discovery.nextBlock, anchor: discovery.anchor }),
    discovery: Object.freeze({
      headBlock: discovery.headBlock,
      safeHead: discovery.safeHead,
      scanned: discovery.scanned,
      declarations: discovery.declarations.length,
    }),
  })
}
