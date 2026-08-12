import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveIdentity } from '../src/protocol/index.js'
import {
  BLOBMAIL_TEXT_RECORD_KEY,
  contactFingerprint,
  createContactCode,
  parseContactCode,
  resolveRecipient,
} from '../src/identity/index.js'

const seed = Uint8Array.from({ length: 32 }, (_, index) => index + 1)

test('contact codes are deterministic, checksummed, and round trip X25519 keys', async () => {
  const identity = await deriveIdentity(seed)
  const code = await createContactCode(identity.publicKeyBytes)
  const parsed = await parseContactCode(code)

  assert.match(code, /^blobmail:v0:x25519:[A-Za-z0-9_-]{43}:[0-9a-f]{16}$/u)
  assert.deepEqual(parsed.publicKeyBytes, identity.publicKeyBytes)
  assert.equal(parsed.identityId, identity.identityId)
  assert.equal(parsed.fingerprint, contactFingerprint(identity.publicKeyBytes))
})

test('contact parser rejects mutation, alternate encoding, whitespace, and unknown versions', async () => {
  const identity = await deriveIdentity(seed)
  const code = await createContactCode(identity.publicKeyBytes)
  const parts = code.split(':')
  const mutated = [...parts]
  mutated[3] = `${mutated[3].slice(0, -1)}${mutated[3].endsWith('A') ? 'B' : 'A'}`

  await assert.rejects(parseContactCode(mutated.join(':')), /checksum/u)
  await assert.rejects(parseContactCode(`${code} `), /whitespace/u)
  await assert.rejects(parseContactCode(code.replace(':v0:', ':v1:')), /unsupported/u)
  await assert.rejects(parseContactCode(code.replace(parts[3], `${parts[3]}=`)), /base64url/u)
})

test('raw, .eth, and .gwei recipients resolve to the same contact record with evidence', async () => {
  const identity = await deriveIdentity(seed)
  const code = await createContactCode(identity.publicKeyBytes)
  const raw = await resolveRecipient(code)
  const options = {
    readEnsText: async (name, key) => ({
      value: code,
      normalizedName: name,
      chainId: 1n,
      blockNumber: 123n,
      resolverAddress: '0x1111111111111111111111111111111111111111',
      key,
    }),
    readGweiText: async (name, key) => ({
      value: code,
      normalizedName: name,
      chainId: 1n,
      blockNumber: 456n,
      resolverAddress: '0x2222222222222222222222222222222222222222',
      key,
    }),
  }
  const ens = await resolveRecipient('alice.eth', options)
  const gns = await resolveRecipient('alice.gwei', options)

  assert.equal(raw.identityId, identity.identityId)
  assert.equal(ens.identityId, identity.identityId)
  assert.equal(gns.identityId, identity.identityId)
  assert.equal(ens.evidence[0].recordKey, BLOBMAIL_TEXT_RECORD_KEY)
  assert.equal(ens.source, 'ens')
  assert.equal(gns.source, 'gns')
})

test('name resolution fails closed on missing, malformed, and unsupported records', async () => {
  await assert.rejects(
    resolveRecipient('alice.eth', { readEnsText: async () => ({ value: '' }) }),
    (error) => error.code === 'BLOBMAIL_RECORD_NOT_FOUND',
  )
  await assert.rejects(
    resolveRecipient('alice.gwei', { readGweiText: async () => ({ value: '0x1234' }) }),
    (error) => error.code === 'INVALID_BLOBMAIL_RECORD',
  )
  await assert.rejects(
    resolveRecipient('alice.example'),
    (error) => error.code === 'UNSUPPORTED_RECIPIENT',
  )
})
