/*
 * Adapted from the public eth-radio read path at commit
 * b465e02f88bbca85932344228c1cfe5abfb51253.
 * Licensed under the Viral Public License; see THIRD_PARTY_NOTICES.md.
 * This module is deliberately pure and contains no publication capability.
 */

export const FIELD_ELEMENT_BYTES = 32
export const PAYLOAD_BYTES_PER_FIELD_ELEMENT = 31
export const FIELD_ELEMENTS_PER_BLOB = 4096
export const BLOB_BYTES = FIELD_ELEMENT_BYTES * FIELD_ELEMENTS_PER_BLOB
export const PAYLOAD_BYTES_PER_BLOB = PAYLOAD_BYTES_PER_FIELD_ELEMENT * FIELD_ELEMENTS_PER_BLOB
export const MAX_BLOBS_PER_BATCH = 16

function assertMaxBlobs(maxBlobs) {
  if (!Number.isSafeInteger(maxBlobs) || maxBlobs < 0 || maxBlobs > MAX_BLOBS_PER_BATCH) {
    throw new RangeError(`maxBlobs must be an integer between 0 and ${MAX_BLOBS_PER_BATCH}`)
  }
}

function asBytes(value, label) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError(`${label} must be an ArrayBuffer or typed-array view`)
}

function assertPayloadBytes(payloadBytes, capacity) {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
    throw new RangeError('payloadBytes must be a non-negative safe integer')
  }
  if (payloadBytes > capacity) {
    throw new RangeError(`payloadBytes ${payloadBytes} exceeds decoded capacity ${capacity}`)
  }
}

function assertSegment(startFE, endFE) {
  if (!Number.isSafeInteger(startFE) || !Number.isSafeInteger(endFE)
    || startFE < 0 || startFE >= endFE || endFE > FIELD_ELEMENTS_PER_BLOB) {
    throw new RangeError(`field-element segment must satisfy 0 <= startFE < endFE <= ${FIELD_ELEMENTS_PER_BLOB}`)
  }
}

function canonicalBlob(value, label = 'blob') {
  const blob = asBytes(value, label)
  if (blob.byteLength !== BLOB_BYTES) {
    throw new RangeError(`${label} must contain exactly ${BLOB_BYTES} bytes`)
  }
  return blob
}

export function segmentPayloadCapacity(startFE, endFE) {
  assertSegment(startFE, endFE)
  return (endFE - startFE) * PAYLOAD_BYTES_PER_FIELD_ELEMENT
}

/**
 * Returns a copy of a blob with payload bytes written only inside an ERC-8179
 * style half-open field-element segment. Bytes outside the segment are
 * preserved so independently constructed segments can share one blob.
 */
export function writePayloadToBlobSegment(blobValue, payload, { startFE, endFE } = {}) {
  const blob = canonicalBlob(blobValue).slice()
  const input = asBytes(payload, 'payload')
  const capacity = segmentPayloadCapacity(startFE, endFE)
  assertPayloadBytes(input.byteLength, capacity)

  const segmentStart = startFE * FIELD_ELEMENT_BYTES
  const segmentEnd = endFE * FIELD_ELEMENT_BYTES
  blob.fill(0, segmentStart, segmentEnd)
  let inputOffset = 0
  for (let fieldIndex = startFE; fieldIndex < endFE && inputOffset < input.byteLength; fieldIndex += 1) {
    const fieldOffset = fieldIndex * FIELD_ELEMENT_BYTES
    const chunkEnd = Math.min(inputOffset + PAYLOAD_BYTES_PER_FIELD_ELEMENT, input.byteLength)
    blob.set(input.subarray(inputOffset, chunkEnd), fieldOffset + 1)
    inputOffset = chunkEnd
  }
  return blob
}

/**
 * Reconstructs an exact-length payload from one declared field-element
 * segment. Only the declared segment is interpreted; unrelated field elements
 * may use another protocol's encoding. Unused bytes in the declared segment
 * must be zero so one declaration has one canonical byte representation.
 */
export function decodePayloadFromBlobSegment(blobValue, payloadBytes, { startFE, endFE } = {}) {
  const blob = canonicalBlob(blobValue)
  const capacity = segmentPayloadCapacity(startFE, endFE)
  assertPayloadBytes(payloadBytes, capacity)
  const output = new Uint8Array(payloadBytes)
  let outputOffset = 0

  for (let fieldIndex = startFE; fieldIndex < endFE; fieldIndex += 1) {
    const fieldOffset = fieldIndex * FIELD_ELEMENT_BYTES
    if (blob[fieldOffset] !== 0) {
      throw new Error(`invalid blob field element prefix at field element ${fieldIndex}`)
    }
    const available = Math.min(PAYLOAD_BYTES_PER_FIELD_ELEMENT, payloadBytes - outputOffset)
    if (available > 0) {
      output.set(blob.subarray(fieldOffset + 1, fieldOffset + 1 + available), outputOffset)
      outputOffset += available
    }
    const unusedStart = fieldOffset + 1 + available
    const fieldEnd = fieldOffset + FIELD_ELEMENT_BYTES
    for (let offset = unusedStart; offset < fieldEnd; offset += 1) {
      if (blob[offset] !== 0) {
        throw new Error(`non-zero padding in blob segment at byte offset ${offset}`)
      }
    }
  }
  return output
}

/**
 * Packs payload bytes into EIP-4844 blob field elements. Each 32-byte field
 * element has a zero prefix followed by exactly 31 payload bytes, with the
 * final blob zero-padded to its canonical 131072-byte size.
 */
export function encodePayloadToBlobs(payload, { maxBlobs = MAX_BLOBS_PER_BATCH } = {}) {
  assertMaxBlobs(maxBlobs)
  const input = asBytes(payload, 'payload')
  const blobCount = Math.ceil(input.byteLength / PAYLOAD_BYTES_PER_BLOB)
  if (blobCount > maxBlobs) {
    throw new RangeError(`payload requires ${blobCount} blobs; limit is ${maxBlobs}`)
  }

  const blobs = []
  for (let blobIndex = 0; blobIndex < blobCount; blobIndex += 1) {
    const blob = new Uint8Array(BLOB_BYTES)
    const payloadStart = blobIndex * PAYLOAD_BYTES_PER_BLOB
    const payloadEnd = Math.min(payloadStart + PAYLOAD_BYTES_PER_BLOB, input.byteLength)
    let inputOffset = payloadStart

    for (let fieldOffset = 0; fieldOffset < BLOB_BYTES && inputOffset < payloadEnd; fieldOffset += FIELD_ELEMENT_BYTES) {
      const chunkEnd = Math.min(inputOffset + PAYLOAD_BYTES_PER_FIELD_ELEMENT, payloadEnd)
      blob.set(input.subarray(inputOffset, chunkEnd), fieldOffset + 1)
      inputOffset = chunkEnd
    }
    blobs.push(blob)
  }
  return blobs
}

/**
 * Reconstructs an exact-length payload and rejects non-canonical field
 * elements. Blobs must have the canonical EIP-4844 byte length.
 */
export function decodePayloadFromBlobs(blobs, payloadBytes, { maxBlobs = MAX_BLOBS_PER_BATCH } = {}) {
  assertMaxBlobs(maxBlobs)
  if (!Array.isArray(blobs)) throw new TypeError('blobs must be an array')
  if (blobs.length > maxBlobs) throw new RangeError(`blob count ${blobs.length} exceeds limit ${maxBlobs}`)

  const capacity = blobs.length * PAYLOAD_BYTES_PER_BLOB
  assertPayloadBytes(payloadBytes, capacity)
  const requiredBlobCount = Math.ceil(payloadBytes / PAYLOAD_BYTES_PER_BLOB)
  if (blobs.length !== requiredBlobCount) {
    throw new RangeError(`payloadBytes ${payloadBytes} requires exactly ${requiredBlobCount} blobs, got ${blobs.length}`)
  }
  const output = new Uint8Array(payloadBytes)
  let outputOffset = 0

  for (const [blobIndex, blobValue] of blobs.entries()) {
    const blob = asBytes(blobValue, `blob ${blobIndex}`)
    if (blob.byteLength !== BLOB_BYTES) {
      throw new RangeError(`blob ${blobIndex} must contain exactly ${BLOB_BYTES} bytes`)
    }

    for (let fieldOffset = 0; fieldOffset < blob.byteLength; fieldOffset += FIELD_ELEMENT_BYTES) {
      if (blob[fieldOffset] !== 0) {
        throw new Error(`invalid blob field element prefix at blob ${blobIndex}, byte offset ${fieldOffset}`)
      }
      if (outputOffset >= payloadBytes) continue
      const available = Math.min(PAYLOAD_BYTES_PER_FIELD_ELEMENT, payloadBytes - outputOffset)
      output.set(blob.subarray(fieldOffset + 1, fieldOffset + 1 + available), outputOffset)
      outputOffset += available
    }
  }
  return output
}
