import process from 'node:process'

import { createPublicClient, createWalletClient, http, keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import {
  createBatcherHttpServer,
  createReferenceBatcher,
  listenBatcherServer,
  publishSegmentPackage,
} from '../src/batcher/index.js'
import { calculateCostEnvelope } from '../src/publication/index.js'
import { createSegmentPublicationPackage } from '../src/publication/index.js'
import { loadNodeKzg } from '../src/sidecars/index.js'
import {
  SEPOLIA_BSS_CONTRACT,
  SEPOLIA_BSS_RUNTIME_BYTES,
  SEPOLIA_BSS_RUNTIME_KECCAK256,
} from '../src/segments/index.js'

const MODE = process.env.BLOBMAIL_BATCHER_MODE ?? 'offline'
const HOST = process.env.BLOBMAIL_BATCHER_HOST ?? '127.0.0.1'
const PORT = Number(process.env.BLOBMAIL_BATCHER_PORT ?? '8787')
const ALLOWED_ORIGIN = process.env.BLOBMAIL_BATCHER_ALLOWED_ORIGIN ?? 'http://127.0.0.1:5173'
const RPC_URL = process.env.BLOBMAIL_BATCHER_SEPOLIA_RPC_URL

function canonicalPositive(value, fallback, label) {
  const selected = value ?? fallback
  if (!/^[1-9]\d*$/u.test(String(selected))) throw new Error(`${label} must be a positive canonical decimal integer`)
  return String(selected)
}

if (!['offline', 'sepolia'].includes(MODE)) throw new Error('BLOBMAIL_BATCHER_MODE must be offline or sepolia')
if (HOST !== '127.0.0.1') throw new Error('the reference batcher binds only to 127.0.0.1')
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('BLOBMAIL_BATCHER_PORT is invalid')

const kzg = await loadNodeKzg()
let publish
let publicAddress = null

if (MODE === 'offline') {
  publish = async (entries) => {
    const publicationPackage = await createSegmentPublicationPackage({ entries, kzg })
    return Object.freeze({
      status: 'packaged',
      batchId: publicationPackage.batch.batchId,
      entryIds: publicationPackage.batch.entryIds,
      manifest: publicationPackage.manifest,
    })
  }
} else {
  if (!RPC_URL || !/^https:\/\//u.test(RPC_URL)) throw new Error('live mode requires an HTTPS BLOBMAIL_BATCHER_SEPOLIA_RPC_URL')
  const secret = process.env.BLOBMAIL_BATCHER_PRIVATE_KEY
  if (!/^0x[0-9a-fA-F]{64}$/u.test(String(secret ?? ''))) throw new Error('live mode requires a 32-byte BLOBMAIL_BATCHER_PRIVATE_KEY')
  const account = privateKeyToAccount(secret)
  publicAddress = account.address
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL, { retryCount: 1, timeout: 10_000 }) })
  const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC_URL, { retryCount: 1, timeout: 10_000 }) })
  const chainId = await publicClient.getChainId()
  if (chainId !== sepolia.id) throw new Error(`batcher RPC returned chain ${chainId}, expected Sepolia`)
  const bytecode = await publicClient.getCode({ address: SEPOLIA_BSS_CONTRACT })
  if (!bytecode || (bytecode.length - 2) / 2 !== SEPOLIA_BSS_RUNTIME_BYTES
    || keccak256(bytecode) !== SEPOLIA_BSS_RUNTIME_KECCAK256) {
    throw new Error('Sepolia BSS contract bytecode does not match the pinned deployment')
  }
  const gasLimit = canonicalPositive(process.env.BLOBMAIL_BATCHER_GAS_LIMIT, '80000', 'gas limit')
  const maxFeePerGas = canonicalPositive(process.env.BLOBMAIL_BATCHER_MAX_FEE_PER_GAS_WEI, '20000000000', 'max fee per gas')
  const priority = canonicalPositive(process.env.BLOBMAIL_BATCHER_MAX_PRIORITY_FEE_PER_GAS_WEI, '1000000000', 'priority fee')
  const maxFeePerBlobGas = canonicalPositive(process.env.BLOBMAIL_BATCHER_MAX_FEE_PER_BLOB_GAS_WEI, '20000000000', 'max blob fee')
  const maxTotal = canonicalPositive(process.env.BLOBMAIL_BATCHER_MAX_TOTAL_EXPOSURE_WEI, '5000000000000000', 'total exposure')

  publish = async (entries) => {
    const [block, blobBaseFee, balance] = await Promise.all([
      publicClient.getBlock({ blockTag: 'latest' }),
      publicClient.getBlobBaseFee(),
      publicClient.getBalance({ address: account.address }),
    ])
    const envelope = calculateCostEnvelope({
      reference: {
        baseFeePerGasWei: String(block.baseFeePerGas),
        blobBaseFeeWei: String(blobBaseFee),
      },
      fees: {
        gasLimit,
        maxFeePerGasWei: maxFeePerGas,
        maxPriorityFeePerGasWei: priority,
        maxFeePerBlobGasWei: maxFeePerBlobGas,
      },
      caps: {
        maxExecutionCostWei: String(BigInt(gasLimit) * BigInt(maxFeePerGas)),
        maxBlobCostWei: String(131072n * BigInt(maxFeePerBlobGas)),
        maxTotalExposureWei: maxTotal,
      },
    })
    if (balance < BigInt(envelope.totalUpperBoundWei)) throw new Error('batcher balance is below the bounded transaction exposure')
    const publicationPackage = await createSegmentPublicationPackage({ entries, kzg })
    return publishSegmentPackage({
      publicationPackage,
      walletClient,
      kzg,
      gas: BigInt(gasLimit),
      maxFeePerGas: BigInt(maxFeePerGas),
      maxPriorityFeePerGas: BigInt(priority),
      maxFeePerBlobGas: BigInt(maxFeePerBlobGas),
      waitForTransactionReceipt: (request) => publicClient.waitForTransactionReceipt(request),
      confirmations: 2,
    })
  }
}

const batcher = createReferenceBatcher({ publish })
const server = createBatcherHttpServer({ batcher, allowedOrigin: ALLOWED_ORIGIN })
// Exit code for a startup listen failure (port in use, permission denied), distinct
// from Node's generic exit code 1 for an uncaught exception.
const EXIT_LISTEN_FAILED = 2
try {
  await listenBatcherServer(server, { port: PORT, host: HOST })
} catch (error) {
  console.error(JSON.stringify({
    schema: 'blobmail.reference-batcher-error.v1',
    code: error.code,
    message: error.message,
  }))
  process.exit(EXIT_LISTEN_FAILED)
}
server.on('error', (error) => {
  console.error(JSON.stringify({
    schema: 'blobmail.reference-batcher-error.v1',
    code: 'SERVER_ERROR',
    message: String(error?.code ?? error?.message ?? 'unknown server error'),
  }))
  process.exitCode = 1
  server.close()
})
console.log(JSON.stringify({
  schema: 'blobmail.reference-batcher-start.v1',
  mode: MODE,
  origin: `http://${HOST}:${PORT}`,
  allowedOrigin: ALLOWED_ORIGIN,
  contractAddress: SEPOLIA_BSS_CONTRACT,
  ...(publicAddress ? { publisherAddress: publicAddress } : {}),
}))
