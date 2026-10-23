import { hexToBytes } from '../transport/index.js'
import { verifyEntry } from '../protocol/index.js'

export const MAX_BATCHER_JOBS = 128
export const MAX_SUBMISSION_BYTES = 4096

export class BatcherServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'BatcherServiceError'
    this.code = code
    this.status = status
  }
}

function publicJob(job) {
  return Object.freeze({
    schema: 'blobmail.batcher-job.v1',
    id: job.id,
    entryId: job.entryId,
    status: job.status,
    submittedAt: job.submittedAt,
    updatedAt: job.updatedAt,
    ...(job.transactionHash ? { transactionHash: job.transactionHash } : {}),
    ...(job.batchId ? { batchId: job.batchId } : {}),
    ...(job.manifest ? { manifest: job.manifest } : {}),
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
  })
}

export function createReferenceBatcher({ publish, now = () => new Date().toISOString(), maxJobs = MAX_BATCHER_JOBS } = {}) {
  if (typeof publish !== 'function') throw new TypeError('publish function is required')
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > MAX_BATCHER_JOBS) {
    throw new RangeError(`maxJobs must be between 1 and ${MAX_BATCHER_JOBS}`)
  }
  const jobs = new Map()
  const pending = new Set()

  function evict() {
    while (jobs.size >= maxJobs) {
      const candidate = [...jobs.values()].find((job) => ['packaged', 'submitted', 'included', 'failed'].includes(job.status))
      if (!candidate) throw new BatcherServiceError('QUEUE_FULL', 'batcher queue is full', 503)
      jobs.delete(candidate.id)
    }
  }

  async function process(job, entryBytes) {
    // Admission checked expiresAt before the (async) entry verification; re-check
    // immediately before publication so an entry that expired in between is never
    // handed to the publisher ("expired before inclusion" is a terminal failure).
    if (job.expiresAt !== undefined && Date.parse(job.expiresAt) <= Date.parse(now())) {
      job.status = 'failed'
      job.errorCode = 'EXPIRED'
      job.updatedAt = now()
      return
    }
    job.status = 'publishing'
    job.updatedAt = now()
    try {
      const receipt = await publish([entryBytes])
      if (!receipt || !['packaged', 'submitted', 'included'].includes(receipt.status)
        || typeof receipt.batchId !== 'string'
        || (receipt.status !== 'packaged' && typeof receipt.transactionHash !== 'string')) {
        throw new Error('publisher returned an invalid receipt')
      }
      Object.assign(job, {
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        batchId: receipt.batchId,
        manifest: receipt.manifest,
        updatedAt: now(),
      })
    } catch (error) {
      job.status = 'failed'
      job.errorCode = typeof error?.code === 'string' ? error.code : 'PUBLICATION_FAILED'
      job.updatedAt = now()
    }
  }

  async function submit({ entryHex, expiresAt } = {}) {
    if (typeof entryHex !== 'string' || entryHex.length > MAX_SUBMISSION_BYTES * 2 + 2) {
      throw new BatcherServiceError('INVALID_ENTRY', 'entryHex is missing or exceeds the request bound')
    }
    if (expiresAt !== undefined && (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)))) {
      throw new BatcherServiceError('INVALID_EXPIRY', 'expiresAt must be an ISO date when present')
    }
    if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(now())) {
      throw new BatcherServiceError('EXPIRED', 'submission has already expired')
    }
    let verified
    try {
      verified = await verifyEntry(hexToBytes(entryHex, 'entryHex'))
    } catch {
      throw new BatcherServiceError('INVALID_ENTRY', 'entryHex is not a canonical encrypted BlobMail entry')
    }
    const existing = jobs.get(verified.entryId)
    if (existing) return publicJob(existing)
    evict()
    const timestamp = now()
    const job = {
      id: verified.entryId,
      entryId: verified.entryId,
      status: 'queued',
      submittedAt: timestamp,
      updatedAt: timestamp,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    }
    jobs.set(job.id, job)
    const task = process(job, verified.entryBytes.slice()).finally(() => pending.delete(task))
    pending.add(task)
    return publicJob(job)
  }

  function get(id) {
    const job = jobs.get(id)
    if (!job) throw new BatcherServiceError('NOT_FOUND', 'batcher job was not found', 404)
    return publicJob(job)
  }

  async function waitForIdle() {
    await Promise.all([...pending])
  }

  return Object.freeze({ submit, get, waitForIdle, size: () => jobs.size })
}
