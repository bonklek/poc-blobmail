import { BLOB_BYTES } from '../transport/index.js'

const DEFAULT_MAX_ENTRIES = 4
const DEFAULT_MAX_BYTES = BLOB_BYTES * 8

function assertLimit(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}`)
  }
}

function cloneSidecar(sidecar) {
  return Object.freeze({
    index: sidecar.index,
    versionedHash: sidecar.versionedHash,
    commitment: sidecar.commitment,
    kzgProof: sidecar.kzgProof,
    blob: sidecar.blob.slice(),
  })
}

function entryBytes(sidecars) {
  return sidecars.reduce((sum, sidecar) => sum + sidecar.blob.byteLength + 160, 0)
}

export function createBoundedSidecarCache({
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  assertLimit(maxEntries, 'maxEntries', 32)
  assertLimit(maxBytes, 'maxBytes', BLOB_BYTES * 32)
  const entries = new Map()
  let bytes = 0

  return Object.freeze({
    get(key) {
      if (typeof key !== 'string' || key.length < 1 || key.length > 2_048) return null
      const value = entries.get(key)
      if (!value) return null
      entries.delete(key)
      entries.set(key, value)
      return Object.freeze(value.sidecars.map(cloneSidecar))
    },
    set(key, sidecars) {
      if (typeof key !== 'string' || key.length < 1 || key.length > 2_048) {
        throw new TypeError('cache key must be a bounded string')
      }
      if (!Array.isArray(sidecars) || sidecars.length < 1 || sidecars.length > 6) {
        throw new RangeError('cached sidecars must contain 1 to 6 items')
      }
      const stored = sidecars.map(cloneSidecar)
      const size = entryBytes(stored)
      if (size > maxBytes) throw new RangeError('cache entry exceeds the byte limit')
      const previous = entries.get(key)
      if (previous) {
        bytes -= previous.bytes
        entries.delete(key)
      }
      while (entries.size >= maxEntries || bytes + size > maxBytes) {
        const oldest = entries.keys().next().value
        const evicted = entries.get(oldest)
        entries.delete(oldest)
        bytes -= evicted.bytes
      }
      entries.set(key, { sidecars: stored, bytes: size })
      bytes += size
    },
    clear() {
      entries.clear()
      bytes = 0
    },
    stats() {
      return Object.freeze({ entries: entries.size, bytes, maxEntries, maxBytes })
    },
  })
}
