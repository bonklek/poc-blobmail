import assert from 'node:assert/strict'
import test from 'node:test'

import { deriveIdentity } from '../src/protocol/index.js'
import {
  VAULT_KDF_ITERATIONS,
  createContactCode,
  createIdentityVault,
  openIdentityVault,
  openIdentityVaultSession,
  sealIdentityVault,
} from '../src/identity/index.js'

const PASSPHRASE = 'correct horse battery staple'

test('identity vault creates, encrypts, unlocks, and restores contacts', async () => {
  const contactIdentity = await deriveIdentity(Uint8Array.from({ length: 32 }, (_, index) => index + 10))
  const contactCode = await createContactCode(contactIdentity.publicKeyBytes)
  const created = await createIdentityVault(PASSPHRASE, {
    now: () => '2026-08-12T00:00:00.000Z',
    contacts: [{ label: 'Bob', recipient: 'bob.gwei', contactCode }],
  })

  assert.doesNotMatch(created.envelope, new RegExp(created.identity.contactCode.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'))
  const parsedEnvelope = JSON.parse(created.envelope)
  assert.equal(parsedEnvelope.kdf.iterations, VAULT_KDF_ITERATIONS)
  assert.equal(parsedEnvelope.cipher.name, 'AES-256-GCM')

  const opened = await openIdentityVault(created.envelope, PASSPHRASE)
  assert.equal(opened.createdAt, '2026-08-12T00:00:00.000Z')
  assert.equal(opened.identity.identityId, created.identity.identityId)
  assert.equal(opened.contactCode, created.identity.contactCode)
  assert.equal(opened.contacts[0].recipient, 'bob.gwei')
  assert.equal(opened.contacts[0].identityId, contactIdentity.identityId)
})

test('identity vault rejects wrong passphrases, ciphertext mutation, and weak passphrases', async () => {
  const created = await createIdentityVault(PASSPHRASE)
  await assert.rejects(
    openIdentityVault(created.envelope, 'this passphrase is wrong'),
    (error) => error.code === 'VAULT_UNLOCK_FAILED',
  )
  const parsed = JSON.parse(created.envelope)
  parsed.cipher.ciphertext = `${parsed.cipher.ciphertext.slice(0, -1)}${parsed.cipher.ciphertext.endsWith('A') ? 'B' : 'A'}`
  await assert.rejects(
    openIdentityVault(JSON.stringify(parsed), PASSPHRASE),
    (error) => ['VAULT_UNLOCK_FAILED', 'INVALID_VAULT'].includes(error.code),
  )
  await assert.rejects(createIdentityVault('too short'), /12 and 1024/u)
})

test('identity vault rejects mismatched keypairs after authenticated decryption', async () => {
  const first = await deriveIdentity(Uint8Array.from({ length: 32 }, (_, index) => index + 1))
  const second = await deriveIdentity(Uint8Array.from({ length: 32 }, (_, index) => 200 - index))
  const mismatched = { ...first, privateKeyBytes: second.privateKeyBytes }
  const envelope = await sealIdentityVault({ identity: mismatched }, PASSPHRASE)
  await assert.rejects(
    openIdentityVault(envelope, PASSPHRASE),
    (error) => error.code === 'INVALID_VAULT' && /keypair/u.test(error.message),
  )
})

test('unlocked session reseals inbox, outbox, and reorg cursor without plaintext storage', async () => {
  const created = await createIdentityVault(PASSPHRASE)
  const session = await openIdentityVaultSession(created.envelope, PASSPHRASE)
  const mailbox = {
    inbox: [{
      entryId: '11'.repeat(32),
      batchId: '22'.repeat(32),
      body: 'encrypted-at-rest inbox text',
      receivedAt: '2026-08-12T01:00:00.000Z',
      transactionHash: `0x${'33'.repeat(32)}`,
      blockNumber: 10,
    }],
    outbox: [{
      entryId: '44'.repeat(32),
      body: 'encrypted-at-rest sent text',
      recipient: 'bob.eth',
      submittedAt: '2026-08-12T01:01:00.000Z',
      status: 'included',
      batchId: '55'.repeat(32),
      transactionHash: `0x${'66'.repeat(32)}`,
    }],
    cursor: { nextBlock: 11, anchor: { blockNumber: 10, blockHash: `0x${'77'.repeat(32)}` } },
  }
  const nextEnvelope = await session.save({ mailbox })
  assert.doesNotMatch(nextEnvelope, /encrypted-at-rest/u)
  assert.equal(session.getVault().mailbox.inbox[0].body, mailbox.inbox[0].body)
  const reopened = await openIdentityVault(nextEnvelope, PASSPHRASE)
  assert.deepEqual(reopened.mailbox, mailbox)
  session.lock()
  assert.throws(() => session.getVault(), { code: 'VAULT_LOCKED' })
})
