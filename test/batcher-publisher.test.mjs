import assert from 'node:assert/strict'
import test from 'node:test'

import { publishSegmentPackage } from '../src/batcher/index.js'

test('publisher forwards one blob and exact BSS calldata under explicit fee caps', async () => {
  let request
  const publicationPackage = {
    schema: 'blobmail.segment-publication-package.v1',
    blob: new Uint8Array(131072),
    transaction: {
      to: '0x1111111111111111111111111111111111111111',
      data: '0x1234',
    },
    batch: { batchId: '22'.repeat(32), entryIds: ['33'.repeat(32)] },
    manifest: { schema: 'blobmail.segment-manifest.v1' },
  }
  const kzg = {
    blobToKZGCommitment: () => `0x${'44'.repeat(48)}`,
    computeBlobKZGProof: () => `0x${'55'.repeat(48)}`,
  }
  const result = await publishSegmentPackage({
    publicationPackage,
    kzg,
    walletClient: { sendTransaction: async (value) => { request = value; return `0x${'66'.repeat(32)}` } },
    maxFeePerGas: '100',
    maxPriorityFeePerGas: '2',
    maxFeePerBlobGas: '10',
  })
  assert.equal(request.blobs.length, 1)
  assert.equal(request.blobs[0].length, 131072 * 2 + 2)
  assert.equal(request.to, publicationPackage.transaction.to)
  assert.equal(request.data, publicationPackage.transaction.data)
  assert.equal(request.maxFeePerGas, 100n)
  assert.equal(result.status, 'submitted')
  assert.equal(result.transactionHash, `0x${'66'.repeat(32)}`)
})

test('publisher records confirmed inclusion only after a successful receipt', async () => {
  const publicationPackage = {
    schema: 'blobmail.segment-publication-package.v1', blob: new Uint8Array(131072),
    transaction: { to: '0x1111111111111111111111111111111111111111', data: '0x' },
    batch: { batchId: '22'.repeat(32), entryIds: [] }, manifest: {},
  }
  const kzg = { blobToKZGCommitment() {}, computeBlobKZGProof() {} }
  const result = await publishSegmentPackage({
    publicationPackage, kzg,
    walletClient: { sendTransaction: async () => `0x${'77'.repeat(32)}` },
    waitForTransactionReceipt: async () => ({
      status: 'success', blockNumber: 123n, blockHash: `0x${'88'.repeat(32)}`,
    }),
    maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, maxFeePerBlobGas: 2n,
  })
  assert.equal(result.status, 'included')
  assert.equal(result.inclusion.blockNumber, '123')
})

test('publisher rejects missing clients and inconsistent fee caps before signing', async () => {
  const publicationPackage = {
    schema: 'blobmail.segment-publication-package.v1', blob: new Uint8Array(131072),
    transaction: { to: '0x1111111111111111111111111111111111111111', data: '0x' },
    batch: { batchId: '22'.repeat(32), entryIds: [] }, manifest: {},
  }
  const kzg = { blobToKZGCommitment() {}, computeBlobKZGProof() {} }
  await assert.rejects(publishSegmentPackage({ publicationPackage, kzg }), /walletClient/u)
  await assert.rejects(
    publishSegmentPackage({
      publicationPackage, kzg, walletClient: { sendTransaction() { throw new Error('must not run') } },
      maxFeePerGas: 1n, maxPriorityFeePerGas: 2n, maxFeePerBlobGas: 1n,
    }),
    /cannot exceed/u,
  )
})
