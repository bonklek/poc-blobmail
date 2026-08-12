import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  BLOBMAIL_CONTENT_TAG,
  SEPOLIA_BSS_CONTRACT,
} from '../src/segments/index.js'
import { SEPOLIA_CHAIN_ID, SEPOLIA_GENESIS } from '../src/network/index.js'

test('checked-in live MVP receipt binds publication, discovery, KZG, and recipient decryption', async () => {
  const raw = await readFile('reports/sepolia-mvp-live-acceptance.json', 'utf8')
  const report = JSON.parse(raw)
  assert.equal(report.schema, 'blobmail.sepolia-mvp-live-acceptance.v1')
  assert.ok(['PASS_PENDING_FINALITY', 'PASS'].includes(report.result))
  assert.equal(report.network.chainId, SEPOLIA_CHAIN_ID)
  assert.equal(report.network.genesisValidatorsRoot, SEPOLIA_GENESIS.validatorsRoot)
  assert.equal(report.publication.transactionType, 3)
  assert.equal(report.publication.status, 1)
  assert.equal(report.publication.retryCount, 0)
  assert.equal(report.publication.valueWei, '0')
  assert.match(report.publication.blockHash, /^0x[0-9a-f]{64}$/u)
  assert.equal(report.result === 'PASS', report.receiver.finalizedAtObservation)
  assert.equal(report.declaration.contractAddress, SEPOLIA_BSS_CONTRACT)
  assert.equal(report.declaration.contentTag, BLOBMAIL_CONTENT_TAG)
  assert.equal(report.declaration.endFE - report.declaration.startFE, 22)
  assert.equal(report.declaration.versionedHash, report.declaration.versionedHash.toLowerCase())
  assert.equal(report.receiver.result, 'PASS')
  assert.equal(report.receiver.commitmentHashVerified, true)
  assert.equal(report.receiver.kzgProofVerified, true)
  assert.equal(report.receiver.batchReconstructed, true)
  assert.equal(report.receiver.recipientMatches, 1)
  assert.equal(report.receiver.notForRecipient, 0)
  assert.equal(report.receiver.unrelatedRecipientMatches, 0)
  assert.equal(report.receiver.unrelatedNotForRecipient, 1)
  assert.ok(BigInt(report.publication.actualTotalCostWei) <= BigInt(report.publication.maximumExposureWei))
  assert.equal(
    BigInt(report.publication.executionCostWei) + BigInt(report.publication.blobCostWei),
    BigInt(report.publication.actualTotalCostWei),
  )
  assert.equal(
    BigInt(report.publication.balanceBeforeWei) - BigInt(report.publication.balanceAfterWei),
    BigInt(report.publication.actualTotalCostWei),
  )
  assert.deepEqual(report.negativeClaims, {
    containsPrivateKey: false,
    containsRpcCredential: false,
    containsRawSignedTransaction: false,
    containsPlaintext: false,
    deliveryReceipt: false,
    readReceipt: false,
  })
  assert.doesNotMatch(raw, /BEGIN .*PRIVATE KEY|mnemonic|seed phrase|bearer\s|https:\/\/[^/\s:@]+:[^@\s]+@/iu)
})
