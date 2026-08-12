import { decryptEntry, deriveIdentity, encryptText, importIdentity } from '../protocol/index.js'
import { createContactCode, parseContactCode } from './contact.js'

export const VAULT_SCHEMA = 'blobmail.identity-vault.v1'
export const VAULT_PAYLOAD_SCHEMA = 'blobmail.identity-vault-payload.v1'
export const VAULT_KDF_ITERATIONS = 600_000
export const MAX_VAULT_BYTES = 256 * 1024
export const MAX_VAULT_CONTACTS = 64

const AAD = new TextEncoder().encode('BlobMail/v1/identity-vault\0')
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export class IdentityVaultError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'IdentityVaultError'
    this.code = code
  }
}

function fail(code, message) {
  throw new IdentityVaultError(code, message)
}

function encodeBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeBase64Url(value, expectedBytes, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) fail('INVALID_VAULT', `${label} is not base64url`)
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  let binary
  try {
    binary = atob(padded)
  } catch {
    fail('INVALID_VAULT', `${label} is not valid base64url`)
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if (bytes.byteLength !== expectedBytes || encodeBase64Url(bytes) !== value) {
    fail('INVALID_VAULT', `${label} has the wrong length or encoding`)
  }
  return bytes
}

function validatePassphrase(passphrase) {
  if (typeof passphrase !== 'string') throw new TypeError('passphrase must be a string')
  const length = encoder.encode(passphrase).byteLength
  if (length < 12 || length > 1024) {
    throw new RangeError('passphrase must contain between 12 and 1024 UTF-8 bytes')
  }
  return encoder.encode(passphrase)
}

async function deriveVaultKey(passphraseBytes, salt, usages) {
  const material = await globalThis.crypto.subtle.importKey(
    'raw', passphraseBytes, 'PBKDF2', false, ['deriveKey'],
  )
  return globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: VAULT_KDF_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  )
}

function cleanContacts(value) {
  if (!Array.isArray(value)) return []
  if (value.length > MAX_VAULT_CONTACTS) throw new RangeError(`vault supports at most ${MAX_VAULT_CONTACTS} contacts`)
  return value.map((contact, index) => {
    if (!contact || typeof contact !== 'object' || Array.isArray(contact)) {
      throw new TypeError(`contact ${index} must be an object`)
    }
    const label = String(contact.label ?? '')
    const recipient = String(contact.recipient ?? '')
    const contactCode = String(contact.contactCode ?? '')
    if (encoder.encode(label).byteLength < 1 || encoder.encode(label).byteLength > 128) {
      throw new RangeError(`contact ${index} label must contain 1 to 128 UTF-8 bytes`)
    }
    if (encoder.encode(recipient).byteLength < 1 || encoder.encode(recipient).byteLength > 255) {
      throw new RangeError(`contact ${index} recipient must contain 1 to 255 UTF-8 bytes`)
    }
    return { label, recipient, contactCode }
  })
}

async function validateContacts(contacts) {
  const results = []
  const identities = new Set()
  for (const [index, contact] of contacts.entries()) {
    let parsed
    try {
      parsed = await parseContactCode(contact.contactCode)
    } catch {
      fail('INVALID_VAULT', `contact ${index} contains an invalid contact code`)
    }
    if (identities.has(parsed.identityId)) fail('INVALID_VAULT', `contact ${index} duplicates another identity`)
    identities.add(parsed.identityId)
    results.push(Object.freeze({ ...contact, identityId: parsed.identityId, fingerprint: parsed.fingerprint }))
  }
  return Object.freeze(results)
}

async function assertIdentityPair(identity) {
  try {
    const check = await encryptText({ text: 'BlobMail vault key check', recipientIdentity: identity })
    const opened = await decryptEntry({ entryBytes: check.entryBytes, recipientIdentity: identity })
    if (opened.text !== 'BlobMail vault key check') fail('INVALID_VAULT', 'vault identity keypair does not match')
  } catch (error) {
    if (error instanceof IdentityVaultError) throw error
    fail('INVALID_VAULT', 'vault identity keypair does not match')
  }
}

export async function sealIdentityVault({ identity, contacts = [], createdAt } = {}, passphrase) {
  if (!identity?.publicKeyBytes || !identity?.privateKeyBytes) {
    throw new TypeError('identity with public and private key bytes is required')
  }
  const passphraseBytes = validatePassphrase(passphrase)
  const clean = cleanContacts(contacts)
  const contactCode = await createContactCode(identity.publicKeyBytes)
  const payload = {
    schema: VAULT_PAYLOAD_SCHEMA,
    createdAt: createdAt ?? new Date().toISOString(),
    identity: {
      publicKey: encodeBase64Url(identity.publicKeyBytes),
      privateKey: encodeBase64Url(identity.privateKeyBytes),
      identityId: identity.identityId,
      contactCode,
    },
    contacts: clean,
  }
  const plaintext = encoder.encode(JSON.stringify(payload))
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  try {
    const key = await deriveVaultKey(passphraseBytes, salt, ['encrypt'])
    const ciphertext = new Uint8Array(await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 }, key, plaintext,
    ))
    const envelope = JSON.stringify({
      schema: VAULT_SCHEMA,
      kdf: { name: 'PBKDF2-SHA-256', iterations: VAULT_KDF_ITERATIONS, salt: encodeBase64Url(salt) },
      cipher: { name: 'AES-256-GCM', iv: encodeBase64Url(iv), ciphertext: encodeBase64Url(ciphertext) },
    })
    if (encoder.encode(envelope).byteLength > MAX_VAULT_BYTES) throw new RangeError('encrypted vault exceeds its storage bound')
    return envelope
  } finally {
    passphraseBytes.fill(0)
    plaintext.fill(0)
  }
}

export async function createIdentityVault(passphrase, { contacts = [], now } = {}) {
  const identity = await deriveIdentity()
  const createdAt = (now ?? (() => new Date().toISOString()))()
  const envelope = await sealIdentityVault({ identity, contacts, createdAt }, passphrase)
  return Object.freeze({
    envelope,
    identity: Object.freeze({
      identityId: identity.identityId,
      publicKeyBytes: identity.publicKeyBytes.slice(),
      contactCode: await createContactCode(identity.publicKeyBytes),
    }),
  })
}

export async function openIdentityVault(envelope, passphrase) {
  const passphraseBytes = validatePassphrase(passphrase)
  if (typeof envelope !== 'string' || encoder.encode(envelope).byteLength > MAX_VAULT_BYTES) {
    fail('INVALID_VAULT', 'encrypted vault is missing or exceeds its storage bound')
  }
  let parsed
  try {
    parsed = JSON.parse(envelope)
  } catch {
    fail('INVALID_VAULT', 'encrypted vault is not JSON')
  }
  if (parsed?.schema !== VAULT_SCHEMA || parsed?.kdf?.name !== 'PBKDF2-SHA-256'
    || parsed.kdf.iterations !== VAULT_KDF_ITERATIONS || parsed?.cipher?.name !== 'AES-256-GCM') {
    fail('INVALID_VAULT', 'encrypted vault parameters are unsupported')
  }
  const salt = decodeBase64Url(parsed.kdf.salt, 16, 'vault salt')
  const iv = decodeBase64Url(parsed.cipher.iv, 12, 'vault IV')
  const ciphertext = decodeBase64Url(parsed.cipher.ciphertext, parsed.cipher.ciphertext.length * 3 >> 2, 'vault ciphertext')
  let plaintext
  try {
    const key = await deriveVaultKey(passphraseBytes, salt, ['decrypt'])
    plaintext = new Uint8Array(await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 }, key, ciphertext,
    ))
  } catch {
    fail('VAULT_UNLOCK_FAILED', 'wrong passphrase or corrupted encrypted vault')
  } finally {
    passphraseBytes.fill(0)
  }
  try {
    let payload
    try {
      payload = JSON.parse(decoder.decode(plaintext))
    } catch {
      fail('INVALID_VAULT', 'vault plaintext is not canonical UTF-8 JSON')
    }
    if (payload?.schema !== VAULT_PAYLOAD_SCHEMA || typeof payload.createdAt !== 'string'
      || !payload.identity || typeof payload.identity !== 'object') {
      fail('INVALID_VAULT', 'vault payload schema is invalid')
    }
    const publicKeyBytes = decodeBase64Url(payload.identity.publicKey, 32, 'public key')
    const privateKeyBytes = decodeBase64Url(payload.identity.privateKey, 32, 'private key')
    const identity = await importIdentity({ publicKeyBytes, privateKeyBytes })
    if (identity.identityId !== payload.identity.identityId
      || await createContactCode(publicKeyBytes) !== payload.identity.contactCode) {
      fail('INVALID_VAULT', 'vault identity metadata does not match its public key')
    }
    await assertIdentityPair(identity)
    const contacts = await validateContacts(cleanContacts(payload.contacts))
    return Object.freeze({
      schema: VAULT_PAYLOAD_SCHEMA,
      createdAt: payload.createdAt,
      identity,
      contactCode: payload.identity.contactCode,
      contacts,
    })
  } finally {
    plaintext?.fill(0)
  }
}
