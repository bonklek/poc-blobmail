import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  stringToHex,
} from 'viem'

import {
  BLOB_BYTES,
  FIELD_ELEMENTS_PER_BLOB,
  PAYLOAD_BYTES_PER_FIELD_ELEMENT,
  decodePayloadFromBlobSegment,
  segmentPayloadCapacity,
  writePayloadToBlobSegment,
} from '../transport/index.js'
import { parseBatch } from '../protocol/index.js'

const BATCH_HEADER_SIZE = 16
const BATCH_ENTRY_SIZE = 616
const BATCH_TRAILER_SIZE = 32
const BATCH_MAGIC = Uint8Array.from([0x42, 0x4d, 0x42, 0x30])

export const BLOBMAIL_SEGMENT_SCHEMA = 'blobmail.segment-manifest.v1'
export const BLOBMAIL_CONTENT_TAG_LABEL = 'blobmail.v0'
export const BLOBMAIL_CONTENT_TAG = keccak256(stringToHex(BLOBMAIL_CONTENT_TAG_LABEL))
export const SEPOLIA_BSS_CONTRACT = '0x9C4b230066a6808D83F5FBa0c040E0Df2Fcc7314'
export const SEPOLIA_BSS_RUNTIME_BYTES = 815
export const SEPOLIA_BSS_RUNTIME_KECCAK256 = '0x2deac23c20a770f42f564eeefad061c86b9315ef2cfa9856752aee9451300e0f'

export const BSS_ABI = Object.freeze([
  {
    type: 'function',
    name: 'declareBlobSegment',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'blobIndex', type: 'uint256' },
      { name: 'startFE', type: 'uint16' },
      { name: 'endFE', type: 'uint16' },
      { name: 'contentTag', type: 'bytes32' },
    ],
    outputs: [{ name: 'versionedHash', type: 'bytes32' }],
  },
  {
    type: 'event',
    name: 'BlobSegmentDeclared',
    anonymous: false,
    inputs: [
      { name: 'versionedHash', type: 'bytes32', indexed: true },
      { name: 'declarer', type: 'address', indexed: true },
      { name: 'startFE', type: 'uint16', indexed: false },
      { name: 'endFE', type: 'uint16', indexed: false },
      { name: 'contentTag', type: 'bytes32', indexed: true },
    ],
  },
])

function asBytes(value, label) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError(`${label} must be a byte array`)
}

function fieldElementCount(payloadBytes) {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1) {
    throw new RangeError('payloadBytes must be a positive safe integer')
  }
  return Math.ceil(payloadBytes / PAYLOAD_BYTES_PER_FIELD_ELEMENT)
}

export function createBlobMailSegment(payload, { startFE = 0, blob = new Uint8Array(BLOB_BYTES) } = {}) {
  const bytes = asBytes(payload, 'payload')
  const count = fieldElementCount(bytes.byteLength)
  const endFE = startFE + count
  if (!Number.isSafeInteger(startFE) || startFE < 0 || endFE > FIELD_ELEMENTS_PER_BLOB) {
    throw new RangeError(`payload does not fit from startFE ${startFE}`)
  }
  const encodedBlob = writePayloadToBlobSegment(blob, bytes, { startFE, endFE })
  return Object.freeze({
    blob: encodedBlob,
    startFE,
    endFE,
    fieldElements: count,
    payloadBytes: bytes.byteLength,
    capacityBytes: segmentPayloadCapacity(startFE, endFE),
  })
}

export function createSegmentManifest({
  payloadBytes,
  payloadSha256,
  batchId,
  blobVersionedHash,
  startFE,
  endFE,
  contractAddress = SEPOLIA_BSS_CONTRACT,
  contentTag = BLOBMAIL_CONTENT_TAG,
} = {}) {
  const expectedElements = fieldElementCount(payloadBytes)
  if (!Number.isSafeInteger(startFE) || !Number.isSafeInteger(endFE)
    || startFE < 0 || endFE !== startFE + expectedElements || endFE > FIELD_ELEMENTS_PER_BLOB) {
    throw new RangeError('manifest range must be the minimal canonical range for payloadBytes')
  }
  if (!/^[0-9a-f]{64}$/u.test(String(payloadSha256 ?? ''))) throw new TypeError('payloadSha256 must be lowercase 32-byte hex')
  if (!/^[0-9a-f]{64}$/u.test(String(batchId ?? ''))) throw new TypeError('batchId must be lowercase 32-byte hex')
  if (!/^0x[0-9a-f]{64}$/u.test(String(blobVersionedHash ?? ''))) throw new TypeError('blobVersionedHash must be lowercase 32-byte 0x hex')
  if (!/^0x[0-9a-f]{64}$/u.test(String(contentTag ?? ''))) throw new TypeError('contentTag must be lowercase 32-byte 0x hex')
  return Object.freeze({
    schema: BLOBMAIL_SEGMENT_SCHEMA,
    chainId: '11155111',
    contractAddress: getAddress(contractAddress),
    contentTag,
    blobIndex: 0,
    blobVersionedHash,
    startFE,
    endFE,
    payloadBytes,
    payloadSha256,
    batchId,
    encoding: '31-byte-data-per-field-element',
  })
}

export function encodeBlobMailSegmentDeclaration(manifest) {
  if (manifest?.schema !== BLOBMAIL_SEGMENT_SCHEMA || manifest.chainId !== '11155111') {
    throw new TypeError('a Sepolia BlobMail segment manifest is required')
  }
  return encodeFunctionData({
    abi: BSS_ABI,
    functionName: 'declareBlobSegment',
    args: [BigInt(manifest.blobIndex), manifest.startFE, manifest.endFE, manifest.contentTag],
  })
}

export function decodeBlobMailSegment(blob, manifest) {
  if (manifest?.schema !== BLOBMAIL_SEGMENT_SCHEMA) throw new TypeError('a BlobMail segment manifest is required')
  return decodePayloadFromBlobSegment(blob, manifest.payloadBytes, {
    startFE: manifest.startFE,
    endFE: manifest.endFE,
  })
}

export async function decodeBlobMailBatchFromDeclaredSegment(blob, { startFE, endFE } = {}) {
  const capacity = segmentPayloadCapacity(startFE, endFE)
  if (capacity < BATCH_HEADER_SIZE + BATCH_ENTRY_SIZE + BATCH_TRAILER_SIZE) {
    throw new RangeError('declared segment is too small for a BlobMail batch')
  }
  const declaredBytes = decodePayloadFromBlobSegment(blob, capacity, { startFE, endFE })
  if (!BATCH_MAGIC.every((byte, index) => declaredBytes[index] === byte)) {
    throw new Error('declared segment does not start with BlobMail batch magic')
  }
  const count = (declaredBytes[8] << 8) | declaredBytes[9]
  const payloadBytes = BATCH_HEADER_SIZE + count * BATCH_ENTRY_SIZE + BATCH_TRAILER_SIZE
  if (count < 1 || count > 64 || payloadBytes > capacity) {
    throw new Error('declared segment contains an invalid BlobMail batch length')
  }
  const payload = decodePayloadFromBlobSegment(blob, payloadBytes, { startFE, endFE })
  const batch = await parseBatch(payload)
  return Object.freeze({ ...batch, payloadBytes })
}

export function parseBlobMailSegmentDeclaration(log, {
  contractAddress = SEPOLIA_BSS_CONTRACT,
  contentTag = BLOBMAIL_CONTENT_TAG,
} = {}) {
  if (!log || typeof log !== 'object' || !Array.isArray(log.topics) || typeof log.data !== 'string') {
    throw new TypeError('event log must contain topics and data')
  }
  if (!isAddressEqual(getAddress(log.address), getAddress(contractAddress))) {
    throw new Error('segment declaration came from an untrusted contract')
  }
  let decoded
  try {
    decoded = decodeEventLog({ abi: BSS_ABI, eventName: 'BlobSegmentDeclared', data: log.data, topics: log.topics, strict: true })
  } catch {
    throw new Error('segment declaration has invalid event data')
  }
  if (decoded.args.contentTag !== contentTag) throw new Error('segment declaration has another content tag')
  if (decoded.args.startFE >= decoded.args.endFE || decoded.args.endFE > FIELD_ELEMENTS_PER_BLOB) {
    throw new Error('segment declaration has an invalid field-element range')
  }
  return Object.freeze({
    versionedHash: decoded.args.versionedHash,
    declarer: getAddress(decoded.args.declarer),
    startFE: decoded.args.startFE,
    endFE: decoded.args.endFE,
    contentTag: decoded.args.contentTag,
  })
}
