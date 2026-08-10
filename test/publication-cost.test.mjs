import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertFreshReference,
  calculateCostEnvelope,
  parseCanonicalUint,
} from '../src/publication/index.js'

const reference = { baseFeePerGasWei: '1000000000', blobBaseFeeWei: '1000000000', blockNumber: '9000000', observedAtUnixSeconds: '1786377600' }
const fees = { gasLimit: '21000', maxFeePerGasWei: '2000000000', maxPriorityFeePerGasWei: '100000000', maxFeePerBlobGasWei: '2000000000' }
const caps = { maxExecutionCostWei: '42000000000000', maxBlobCostWei: '262144000000000', maxTotalExposureWei: '304144000000000' }

test('cost envelope uses exact BigInt upper bounds and accepts equality', () => {
  assert.deepEqual(calculateCostEnvelope({ reference, fees, caps }), {
    blobGasUsed: '131072',
    executionUpperBoundWei: '42000000000000',
    blobUpperBoundWei: '262144000000000',
    totalUpperBoundWei: '304144000000000',
    referenceExecutionWei: '23100000000000',
    referenceBlobWei: '131072000000000',
    referenceTotalWei: '154172000000000',
  })
})

test('component, total, priority, and observed fee caps fail closed', () => {
  assert.throws(() => calculateCostEnvelope({ reference, fees, caps: { ...caps, maxExecutionCostWei: '41999999999999' } }), { code: 'EXECUTION_COST_CAP_EXCEEDED' })
  assert.throws(() => calculateCostEnvelope({ reference, fees, caps: { ...caps, maxBlobCostWei: '262143999999999' } }), { code: 'BLOB_COST_CAP_EXCEEDED' })
  assert.throws(() => calculateCostEnvelope({ reference, fees, caps: { ...caps, maxTotalExposureWei: '304143999999999' } }), { code: 'TOTAL_COST_CAP_EXCEEDED' })
  assert.throws(() => calculateCostEnvelope({ reference, fees: { ...fees, maxPriorityFeePerGasWei: '2000000001' }, caps }), { code: 'PRIORITY_FEE_ABOVE_CAP' })
  assert.throws(() => calculateCostEnvelope({ reference: { ...reference, baseFeePerGasWei: '2000000001' }, fees, caps }), { code: 'EXECUTION_BASE_FEE_ABOVE_CAP' })
  assert.throws(() => calculateCostEnvelope({ reference: { ...reference, blobBaseFeeWei: '2000000001' }, fees, caps }), { code: 'BLOB_BASE_FEE_ABOVE_CAP' })
})

test('integer parsing rejects fractions, exponents, signs, leading zeroes, and uint256 overflow', () => {
  for (const value of ['', '-1', '+1', '1.5', '1e9', '01', 1]) {
    assert.throws(() => parseCanonicalUint(value, 'test'), { code: 'INVALID_INTEGER' })
  }
  assert.throws(() => parseCanonicalUint((2n ** 256n).toString(), 'test'), { code: 'INTEGER_OUT_OF_RANGE' })
})

test('reference freshness uses inclusive boundaries and rejects stale, future, and expired observations', () => {
  const expiry = { validThroughBlock: '9000100', validThroughUnixSeconds: '1786379400' }
  assert.doesNotThrow(() => assertFreshReference({ reference, expiry, review: { currentBlockNumber: '9000100', atUnixSeconds: '1786378200' } }))
  assert.throws(() => assertFreshReference({ reference, expiry, review: { currentBlockNumber: '9000101', atUnixSeconds: '1786378200' } }), { code: 'PUBLICATION_EXPIRED' })
  assert.throws(() => assertFreshReference({ reference, expiry, review: { currentBlockNumber: '9000001', atUnixSeconds: '1786378201' } }), { code: 'STALE_FEE_REFERENCE' })
  assert.throws(() => assertFreshReference({ reference, expiry, review: { currentBlockNumber: '8999999', atUnixSeconds: '1786377599' } }), { code: 'FUTURE_REFERENCE' })
})
