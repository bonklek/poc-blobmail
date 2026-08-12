import { bytesToHex, hexToBytes } from '../transport/index.js'

function bigint(value, label) {
  if (typeof value === 'bigint' && value > 0n) return value
  if (typeof value === 'string' && /^[1-9]\d*$/u.test(value)) return BigInt(value)
  throw new TypeError(`${label} must be a positive bigint or canonical decimal string`)
}

export function viemKzgAdapter(kzg) {
  if (!kzg || typeof kzg.blobToKZGCommitment !== 'function' || typeof kzg.computeBlobKZGProof !== 'function') {
    throw new TypeError('an initialized KZG implementation is required')
  }
  const hex = (value) => typeof value === 'string' ? value : bytesToHex(value)
  return Object.freeze({
    blobToKzgCommitment: (blob) => hexToBytes(kzg.blobToKZGCommitment(hex(blob)), 'KZG commitment'),
    computeBlobKzgProof: (blob, commitment) => hexToBytes(
      kzg.computeBlobKZGProof(hex(blob), hex(commitment)),
      'KZG proof',
    ),
  })
}

export async function publishSegmentPackage({
  publicationPackage,
  walletClient,
  kzg,
  maxFeePerGas,
  maxPriorityFeePerGas,
  maxFeePerBlobGas,
  gas = 80_000n,
  waitForTransactionReceipt,
  confirmations = 2,
} = {}) {
  if (publicationPackage?.schema !== 'blobmail.segment-publication-package.v1') {
    throw new TypeError('a segment publication package is required')
  }
  if (!walletClient || typeof walletClient.sendTransaction !== 'function') {
    throw new TypeError('walletClient.sendTransaction is required')
  }
  const fees = {
    maxFeePerGas: bigint(maxFeePerGas, 'maxFeePerGas'),
    maxPriorityFeePerGas: bigint(maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
    maxFeePerBlobGas: bigint(maxFeePerBlobGas, 'maxFeePerBlobGas'),
    gas: bigint(gas, 'gas'),
  }
  if (fees.maxPriorityFeePerGas > fees.maxFeePerGas) {
    throw new RangeError('maxPriorityFeePerGas cannot exceed maxFeePerGas')
  }
  const transactionHash = await walletClient.sendTransaction({
    blobs: [bytesToHex(publicationPackage.blob)],
    kzg: viemKzgAdapter(kzg),
    to: publicationPackage.transaction.to,
    data: publicationPackage.transaction.data,
    value: 0n,
    ...fees,
  })
  if (typeof transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(transactionHash)) {
    throw new Error('wallet client returned an invalid transaction hash')
  }
  let inclusion
  if (waitForTransactionReceipt !== undefined) {
    if (typeof waitForTransactionReceipt !== 'function') throw new TypeError('waitForTransactionReceipt must be a function')
    if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 64) {
      throw new RangeError('confirmations must be an integer between 1 and 64')
    }
    const receipt = await waitForTransactionReceipt({ hash: transactionHash, confirmations })
    if (!receipt || receipt.status !== 'success' || typeof receipt.blockNumber !== 'bigint'
      || typeof receipt.blockHash !== 'string') {
      throw new Error('blob transaction failed or returned an invalid receipt')
    }
    inclusion = Object.freeze({
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash.toLowerCase(),
      confirmations,
    })
  }
  return Object.freeze({
    schema: 'blobmail.batcher-publication.v1',
    status: inclusion ? 'included' : 'submitted',
    transactionHash: transactionHash.toLowerCase(),
    batchId: publicationPackage.batch.batchId,
    entryIds: publicationPackage.batch.entryIds,
    manifest: publicationPackage.manifest,
    ...(inclusion ? { inclusion } : {}),
  })
}
