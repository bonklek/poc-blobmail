import { identityId, sha256 } from '../protocol/crypto.js'

export const BLOBMAIL_CONTACT_SCHEME = 'blobmail'
export const BLOBMAIL_CONTACT_VERSION = 'v0'
export const BLOBMAIL_CONTACT_KEM = 'x25519'
export const BLOBMAIL_TEXT_RECORD_KEY = 'com.blobmail'

const CONTACT_PREFIX = new TextEncoder().encode('BlobMail/v0/contact-code\0')
const KEY_BYTES = 32
const CHECKSUM_BYTES = 8

function asBytes(value, label) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError(`${label} must be a byte array`)
}

function concatBytes(...values) {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) {
    output.set(value, offset)
    offset += value.byteLength
  }
  return output
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function encodeBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TypeError('contact public key must be unpadded base64url')
  }
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  let binary
  try {
    binary = atob(padded)
  } catch {
    throw new TypeError('contact public key must be valid base64url')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (encodeBase64Url(bytes) !== value) throw new TypeError('contact public key is not canonically encoded')
  return bytes
}

async function checksum(publicKeyBytes) {
  return (await sha256(concatBytes(CONTACT_PREFIX, publicKeyBytes))).subarray(0, CHECKSUM_BYTES)
}

export function contactFingerprint(publicKeyBytes) {
  const bytes = asBytes(publicKeyBytes, 'publicKeyBytes')
  if (bytes.byteLength !== KEY_BYTES) throw new RangeError(`publicKeyBytes must contain ${KEY_BYTES} bytes`)
  return hex(bytes.subarray(0, 6)).toUpperCase().match(/.{1,4}/gu).join(':')
}

export async function createContactCode(publicKeyBytes) {
  const bytes = asBytes(publicKeyBytes, 'publicKeyBytes')
  if (bytes.byteLength !== KEY_BYTES) throw new RangeError(`publicKeyBytes must contain ${KEY_BYTES} bytes`)
  const encodedKey = encodeBase64Url(bytes)
  const encodedChecksum = hex(await checksum(bytes))
  return `${BLOBMAIL_CONTACT_SCHEME}:${BLOBMAIL_CONTACT_VERSION}:${BLOBMAIL_CONTACT_KEM}:${encodedKey}:${encodedChecksum}`
}

export async function parseContactCode(value) {
  if (typeof value !== 'string' || value.length > 160 || value.trim() !== value) {
    throw new TypeError('contact code must be a bounded string without surrounding whitespace')
  }
  const parts = value.split(':')
  if (parts.length !== 5 || parts[0] !== BLOBMAIL_CONTACT_SCHEME
    || parts[1] !== BLOBMAIL_CONTACT_VERSION || parts[2] !== BLOBMAIL_CONTACT_KEM) {
    throw new TypeError('unsupported BlobMail contact code')
  }
  const publicKeyBytes = decodeBase64Url(parts[3])
  if (publicKeyBytes.byteLength !== KEY_BYTES) {
    throw new RangeError(`contact public key must contain ${KEY_BYTES} bytes`)
  }
  if (!/^[0-9a-f]{16}$/u.test(parts[4])) throw new TypeError('contact checksum must be 8-byte lowercase hex')
  const expectedChecksum = hex(await checksum(publicKeyBytes))
  if (parts[4] !== expectedChecksum) throw new Error('contact checksum does not match the public key')
  return Object.freeze({
    schema: 'blobmail.contact.v0',
    contactCode: value,
    publicKeyBytes: publicKeyBytes.slice(),
    identityId: await identityId(publicKeyBytes),
    fingerprint: contactFingerprint(publicKeyBytes),
  })
}
