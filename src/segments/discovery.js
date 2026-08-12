import { encodeEventTopics, getAddress, isAddressEqual } from 'viem'

import { SEPOLIA_CHAIN_ID } from '../network/index.js'
import {
  BLOBMAIL_CONTENT_TAG,
  BSS_ABI,
  SEPOLIA_BSS_CONTRACT,
  parseBlobMailSegmentDeclaration,
} from './profile.js'

const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i
const HEX_32 = /^0x[0-9a-f]{64}$/i

export const SEGMENT_DISCOVERY_LIMITS = Object.freeze({
  maxBlocksPerScan: 2_048,
  maxLogsPerScan: 256,
  confirmations: 2,
  maxRequests: 5,
})

export class SegmentDiscoveryError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SegmentDiscoveryError'
    this.code = code
  }
}

function fail(code, message) {
  throw new SegmentDiscoveryError(code, message)
}

function quantity(value, label) {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) {
    fail('INVALID_RPC_RESPONSE', `${label} must be a canonical hex quantity`)
  }
  const parsed = BigInt(value)
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) fail('INVALID_RPC_RESPONSE', `${label} exceeds the safe range`)
  return Number(parsed)
}

function quantityHex(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_SCAN_RANGE', `${label} must be a non-negative integer`)
  return `0x${value.toString(16)}`
}

function hash(value, label) {
  if (typeof value !== 'string' || !HEX_32.test(value)) fail('INVALID_RPC_RESPONSE', `${label} must be 32-byte hex`)
  return value.toLowerCase()
}

function normalizeAnchor(anchor) {
  if (anchor === null || anchor === undefined) return null
  if (!anchor || typeof anchor !== 'object') fail('INVALID_ANCHOR', 'anchor must be an object')
  return Object.freeze({
    blockNumber: quantityHex(anchor.blockNumber, 'anchor.blockNumber'),
    blockHash: hash(anchor.blockHash, 'anchor.blockHash'),
  })
}

function normalizeLog(log, contractAddress, contentTag) {
  if (!log || typeof log !== 'object' || log.removed === true) fail('INVALID_EVENT_LOG', 'removed or malformed logs are rejected')
  if (!isAddressEqual(getAddress(log.address), contractAddress)) fail('INVALID_EVENT_LOG', 'event address does not match the filter')
  const transactionHash = hash(log.transactionHash, 'event transactionHash')
  const blockHash = hash(log.blockHash, 'event blockHash')
  const blockNumber = quantity(log.blockNumber, 'event blockNumber')
  const logIndex = quantity(log.logIndex, 'event logIndex')
  const declaration = parseBlobMailSegmentDeclaration(log, { contractAddress, contentTag })
  return Object.freeze({ ...declaration, transactionHash, blockHash, blockNumber, logIndex })
}

export async function discoverBlobMailSegments({
  requestRpc,
  fromBlock,
  anchor = null,
  confirmations = SEGMENT_DISCOVERY_LIMITS.confirmations,
  maxBlocks = SEGMENT_DISCOVERY_LIMITS.maxBlocksPerScan,
  contractAddress = SEPOLIA_BSS_CONTRACT,
  contentTag = BLOBMAIL_CONTENT_TAG,
} = {}) {
  if (typeof requestRpc !== 'function') fail('INVALID_RPC_ADAPTER', 'requestRpc must be a function')
  if (!Number.isSafeInteger(fromBlock) || fromBlock < 0) fail('INVALID_SCAN_RANGE', 'fromBlock must be a non-negative integer')
  if (!Number.isSafeInteger(confirmations) || confirmations < 0 || confirmations > 64) {
    fail('INVALID_CONFIRMATIONS', 'confirmations must be between 0 and 64')
  }
  if (!Number.isSafeInteger(maxBlocks) || maxBlocks < 1 || maxBlocks > SEGMENT_DISCOVERY_LIMITS.maxBlocksPerScan) {
    fail('INVALID_SCAN_RANGE', `maxBlocks must be between 1 and ${SEGMENT_DISCOVERY_LIMITS.maxBlocksPerScan}`)
  }
  const trustedContract = getAddress(contractAddress)
  const trustedTag = hash(contentTag, 'contentTag')
  const normalizedAnchor = normalizeAnchor(anchor)
  let requests = 0
  const rpc = async (method, params = []) => {
    requests += 1
    if (requests > SEGMENT_DISCOVERY_LIMITS.maxRequests) fail('REQUEST_LIMIT_EXCEEDED', 'discovery exceeded its request limit')
    try {
      return await requestRpc(method, params)
    } catch {
      fail('RPC_REQUEST_FAILED', `${method} failed`)
    }
  }

  const [rawChainId, rawHead] = await Promise.all([rpc('eth_chainId'), rpc('eth_blockNumber')])
  if (quantity(rawChainId, 'chainId') !== SEPOLIA_CHAIN_ID) fail('CHAIN_ID_MISMATCH', 'execution provider is not Sepolia')
  const headBlock = quantity(rawHead, 'head block')

  if (normalizedAnchor) {
    const anchoredBlock = await rpc('eth_getBlockByNumber', [normalizedAnchor.blockNumber, false])
    if (!anchoredBlock || hash(anchoredBlock.hash, 'anchor canonical hash') !== normalizedAnchor.blockHash) {
      fail('REORG_DETECTED', 'the previous discovery anchor is no longer canonical')
    }
  }

  const safeHead = Math.max(0, headBlock - confirmations)
  if (fromBlock > safeHead) {
    return Object.freeze({
      chainId: SEPOLIA_CHAIN_ID,
      headBlock,
      safeHead,
      scanned: null,
      declarations: Object.freeze([]),
      nextBlock: fromBlock,
      anchor: normalizedAnchor && Object.freeze({
        blockNumber: quantity(normalizedAnchor.blockNumber, 'anchor.blockNumber'),
        blockHash: normalizedAnchor.blockHash,
      }),
      requestCount: requests,
    })
  }

  const toBlock = Math.min(safeHead, fromBlock + maxBlocks - 1)
  const topics = encodeEventTopics({
    abi: BSS_ABI,
    eventName: 'BlobSegmentDeclared',
    args: { contentTag: trustedTag },
  })
  const [rawLogs, boundaryBlock] = await Promise.all([
    rpc('eth_getLogs', [{
      address: trustedContract,
      fromBlock: quantityHex(fromBlock, 'fromBlock'),
      toBlock: quantityHex(toBlock, 'toBlock'),
      topics,
    }]),
    rpc('eth_getBlockByNumber', [quantityHex(toBlock, 'toBlock'), false]),
  ])
  if (!Array.isArray(rawLogs) || rawLogs.length > SEGMENT_DISCOVERY_LIMITS.maxLogsPerScan) {
    fail('LOG_LIMIT_EXCEEDED', `discovery accepts at most ${SEGMENT_DISCOVERY_LIMITS.maxLogsPerScan} logs per scan`)
  }
  if (!boundaryBlock || quantity(boundaryBlock.number, 'boundary block number') !== toBlock) {
    fail('INVALID_RPC_RESPONSE', 'boundary block does not match the requested height')
  }
  const boundaryHash = hash(boundaryBlock.hash, 'boundary block hash')
  const declarations = rawLogs.map((log) => normalizeLog(log, trustedContract, trustedTag))
  declarations.sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex)
  const ids = new Set()
  for (const item of declarations) {
    if (item.blockNumber < fromBlock || item.blockNumber > toBlock) fail('INVALID_EVENT_LOG', 'provider returned a log outside the requested range')
    const id = `${item.transactionHash}:${item.logIndex}`
    if (ids.has(id)) fail('DUPLICATE_EVENT_LOG', 'provider returned a duplicate event log')
    ids.add(id)
  }

  return Object.freeze({
    chainId: SEPOLIA_CHAIN_ID,
    headBlock,
    safeHead,
    scanned: Object.freeze({ fromBlock, toBlock }),
    declarations: Object.freeze(declarations),
    nextBlock: toBlock + 1,
    anchor: Object.freeze({ blockNumber: toBlock, blockHash: boundaryHash }),
    requestCount: requests,
  })
}
