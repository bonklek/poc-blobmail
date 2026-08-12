export const BLOB_GAS_PER_BLOB = 131_072n
export const MAX_REFERENCE_AGE_SECONDS = 600n
export const MAX_VALIDITY_WINDOW_SECONDS = 1_800n
export const MAX_VALIDITY_BLOCKS = 150n
export const HARD_MAX_TOTAL_EXPOSURE_WEI = 10_000_000_000_000_000n

export class PublicationError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PublicationError'
    this.code = code
  }
}

export function publicationFail(code, message) {
  throw new PublicationError(code, message)
}

export function parseCanonicalUint(value, label, { allowZero = true } = {}) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    publicationFail('INVALID_INTEGER', `${label} must be a canonical unsigned decimal string`)
  }
  const parsed = BigInt(value)
  if (!allowZero && parsed === 0n) publicationFail('INVALID_INTEGER', `${label} must be positive`)
  if (parsed >= 2n ** 256n) publicationFail('INTEGER_OUT_OF_RANGE', `${label} exceeds uint256`)
  return parsed
}

const min = (a, b) => (a < b ? a : b)

export function calculateCostEnvelope({ reference, fees, caps }) {
  const gasLimit = parseCanonicalUint(fees.gasLimit, 'fees.gasLimit', { allowZero: false })
  const maxFeePerGas = parseCanonicalUint(fees.maxFeePerGasWei, 'fees.maxFeePerGasWei', { allowZero: false })
  const priority = parseCanonicalUint(fees.maxPriorityFeePerGasWei, 'fees.maxPriorityFeePerGasWei')
  const maxFeePerBlobGas = parseCanonicalUint(fees.maxFeePerBlobGasWei, 'fees.maxFeePerBlobGasWei', { allowZero: false })
  const baseFee = parseCanonicalUint(reference.baseFeePerGasWei, 'reference.baseFeePerGasWei', { allowZero: false })
  const blobBaseFee = parseCanonicalUint(reference.blobBaseFeeWei, 'reference.blobBaseFeeWei', { allowZero: false })
  if (priority > maxFeePerGas) publicationFail('PRIORITY_FEE_ABOVE_CAP', 'priority fee exceeds max fee per gas')
  if (baseFee > maxFeePerGas) publicationFail('EXECUTION_BASE_FEE_ABOVE_CAP', 'observed base fee exceeds max fee per gas')
  if (blobBaseFee > maxFeePerBlobGas) publicationFail('BLOB_BASE_FEE_ABOVE_CAP', 'observed blob base fee exceeds max blob fee')

  const executionUpperBound = gasLimit * maxFeePerGas
  const blobUpperBound = BLOB_GAS_PER_BLOB * maxFeePerBlobGas
  const totalUpperBound = executionUpperBound + blobUpperBound
  const executionCap = parseCanonicalUint(caps.maxExecutionCostWei, 'caps.maxExecutionCostWei', { allowZero: false })
  const blobCap = parseCanonicalUint(caps.maxBlobCostWei, 'caps.maxBlobCostWei', { allowZero: false })
  const totalCap = parseCanonicalUint(caps.maxTotalExposureWei, 'caps.maxTotalExposureWei', { allowZero: false })
  if (totalCap > HARD_MAX_TOTAL_EXPOSURE_WEI) publicationFail('TOTAL_CAP_ABOVE_HARD_LIMIT', 'total exposure cap exceeds the fixture hard limit')
  if (executionUpperBound > executionCap) publicationFail('EXECUTION_COST_CAP_EXCEEDED', 'execution upper bound exceeds cap')
  if (blobUpperBound > blobCap) publicationFail('BLOB_COST_CAP_EXCEEDED', 'blob upper bound exceeds cap')
  if (totalUpperBound > totalCap) publicationFail('TOTAL_COST_CAP_EXCEEDED', 'total upper bound exceeds cap')

  const referenceExecution = gasLimit * min(maxFeePerGas, baseFee + priority)
  const referenceBlob = BLOB_GAS_PER_BLOB * blobBaseFee
  return Object.freeze({
    blobGasUsed: BLOB_GAS_PER_BLOB.toString(),
    executionUpperBoundWei: executionUpperBound.toString(),
    blobUpperBoundWei: blobUpperBound.toString(),
    totalUpperBoundWei: totalUpperBound.toString(),
    referenceExecutionWei: referenceExecution.toString(),
    referenceBlobWei: referenceBlob.toString(),
    referenceTotalWei: (referenceExecution + referenceBlob).toString(),
  })
}

export function assertFreshReference({ reference, expiry, review }) {
  const observedAt = parseCanonicalUint(reference.observedAtUnixSeconds, 'reference.observedAtUnixSeconds')
  const referenceBlock = parseCanonicalUint(reference.blockNumber, 'reference.blockNumber')
  const validTime = parseCanonicalUint(expiry.validThroughUnixSeconds, 'expiry.validThroughUnixSeconds')
  const validBlock = parseCanonicalUint(expiry.validThroughBlock, 'expiry.validThroughBlock')
  const reviewTime = parseCanonicalUint(review.atUnixSeconds, 'review.atUnixSeconds')
  const reviewBlock = parseCanonicalUint(review.currentBlockNumber, 'review.currentBlockNumber')
  if (reviewTime < observedAt || reviewBlock < referenceBlock) publicationFail('FUTURE_REFERENCE', 'fee reference is ahead of the review point')
  if (reviewTime - observedAt > MAX_REFERENCE_AGE_SECONDS) publicationFail('STALE_FEE_REFERENCE', 'fee reference is older than the allowed age')
  if (validTime <= observedAt || validTime - observedAt > MAX_VALIDITY_WINDOW_SECONDS) publicationFail('INVALID_TIME_EXPIRY', 'time expiry is outside the allowed validity window')
  if (validBlock < referenceBlock || validBlock - referenceBlock > MAX_VALIDITY_BLOCKS) publicationFail('INVALID_BLOCK_EXPIRY', 'block expiry is outside the allowed validity window')
  if (reviewTime > validTime || reviewBlock > validBlock) publicationFail('PUBLICATION_EXPIRED', 'fee reference or unsigned artifact has expired')
}
