import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  zeroAddress,
} from 'viem'
import { namehash, normalize } from 'viem/ens'

import { BLOBMAIL_TEXT_RECORD_KEY, parseContactCode } from './contact.js'

export const ENS_REGISTRY_ADDRESS = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
export const GNS_NAME_NFT_ADDRESS = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6'
export const ETHEREUM_MAINNET_CHAIN_ID = 1n
export const SEPOLIA_CHAIN_ID = 11155111n

const ENS_REGISTRY_ABI = [{
  type: 'function',
  name: 'resolver',
  stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }],
  outputs: [{ name: '', type: 'address' }],
}]

const TEXT_READER_ABI = [{
  type: 'function',
  name: 'text',
  stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
  outputs: [{ name: '', type: 'string' }],
}]

const TEXT_WRITER_ABI = [{
  type: 'function',
  name: 'setText',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'node', type: 'bytes32' },
    { name: 'key', type: 'string' },
    { name: 'value', type: 'string' },
  ],
  outputs: [],
}]

const GNS_TEXT_WRITER_ABI = [{
  type: 'function',
  name: 'setText',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'tokenId', type: 'uint256' },
    { name: 'key', type: 'string' },
    { name: 'value', type: 'string' },
  ],
  outputs: [],
}]

export class RecipientResolutionError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'RecipientResolutionError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

function fail(code, message, details) {
  throw new RecipientResolutionError(code, message, details)
}

function quantity(value, label) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/iu.test(value)) {
    fail('INVALID_RPC_RESPONSE', `${label} must be a canonical hex quantity`)
  }
  return BigInt(value)
}

function normalizeName(input, suffix) {
  if (typeof input !== 'string' || input.length < suffix.length + 2 || input.length > 255
    || input.trim() !== input || !input.toLowerCase().endsWith(suffix)) {
    fail('INVALID_RECIPIENT_NAME', `recipient must be a bounded ${suffix} name`)
  }
  let normalized
  try {
    normalized = normalize(input)
  } catch {
    fail('INVALID_RECIPIENT_NAME', 'recipient name does not satisfy ENSIP-15 normalization')
  }
  if (!normalized.endsWith(suffix)) fail('INVALID_RECIPIENT_NAME', `recipient must end in ${suffix}`)
  return normalized
}

async function rpc(request, method, params) {
  if (typeof request !== 'function') fail('INVALID_RESOLVER_ADAPTER', 'an injected JSON-RPC request function is required')
  let result
  try {
    result = await request({ method, params })
  } catch (cause) {
    throw new RecipientResolutionError('RPC_REQUEST_FAILED', `${method} failed`, { cause: cause?.message ?? 'unknown' })
  }
  if (result && typeof result === 'object' && Object.hasOwn(result, 'result')) {
    if (result.error) fail('RPC_REQUEST_FAILED', `${method} returned an error`)
    return result.result
  }
  return result
}

async function ethCall(request, to, data, blockTag = 'latest') {
  const result = await rpc(request, 'eth_call', [{ to, data }, blockTag])
  if (typeof result !== 'string' || !/^0x(?:[0-9a-f]{2})*$/iu.test(result)) {
    fail('INVALID_RPC_RESPONSE', 'eth_call returned invalid byte hex')
  }
  return result
}

function decode(abi, functionName, data) {
  try {
    return decodeFunctionResult({ abi, functionName, data })
  } catch {
    fail('INVALID_RPC_RESPONSE', `${functionName} returned invalid ABI data`)
  }
}

export function createEthereumTextRecordReader({ request, expectedChainId, gnsContract = GNS_NAME_NFT_ADDRESS } = {}) {
  if (![ETHEREUM_MAINNET_CHAIN_ID, SEPOLIA_CHAIN_ID].includes(expectedChainId)) {
    throw new RangeError('expectedChainId must be Ethereum mainnet or Sepolia')
  }
  const normalizedGnsContract = getAddress(gnsContract)

  async function context() {
    const [chainHex, blockHex] = await Promise.all([
      rpc(request, 'eth_chainId', []),
      rpc(request, 'eth_blockNumber', []),
    ])
    const chainId = quantity(chainHex, 'chainId')
    if (chainId !== expectedChainId) {
      fail('CHAIN_ID_MISMATCH', `resolver returned chain ${chainId}; expected ${expectedChainId}`)
    }
    return { chainId, blockNumber: quantity(blockHex, 'blockNumber'), blockTag: blockHex.toLowerCase() }
  }

  async function readEnsText(name, key = BLOBMAIL_TEXT_RECORD_KEY) {
    const normalizedName = normalizeName(name, '.eth')
    const node = namehash(normalizedName)
    const observed = await context()
    const resolverResult = await ethCall(request, ENS_REGISTRY_ADDRESS, encodeFunctionData({
      abi: ENS_REGISTRY_ABI,
      functionName: 'resolver',
      args: [node],
    }), observed.blockTag)
    const resolverAddress = getAddress(decode(ENS_REGISTRY_ABI, 'resolver', resolverResult))
    if (isAddressEqual(resolverAddress, zeroAddress)) fail('NAME_HAS_NO_RESOLVER', `${normalizedName} has no resolver`)
    const textResult = await ethCall(request, resolverAddress, encodeFunctionData({
      abi: TEXT_READER_ABI,
      functionName: 'text',
      args: [node, key],
    }), observed.blockTag)
    return Object.freeze({
      value: decode(TEXT_READER_ABI, 'text', textResult),
      normalizedName,
      node,
      resolverAddress,
      registryAddress: ENS_REGISTRY_ADDRESS,
      chainId: observed.chainId,
      blockNumber: observed.blockNumber,
    })
  }

  async function readGweiText(name, key = BLOBMAIL_TEXT_RECORD_KEY) {
    const normalizedName = normalizeName(name, '.gwei')
    const node = namehash(normalizedName)
    const observed = await context()
    const textResult = await ethCall(request, normalizedGnsContract, encodeFunctionData({
      abi: TEXT_READER_ABI,
      functionName: 'text',
      args: [node, key],
    }), observed.blockTag)
    return Object.freeze({
      value: decode(TEXT_READER_ABI, 'text', textResult),
      normalizedName,
      node,
      resolverAddress: normalizedGnsContract,
      contractAddress: normalizedGnsContract,
      chainId: observed.chainId,
      blockNumber: observed.blockNumber,
    })
  }

  return Object.freeze({ readEnsText, readGweiText })
}

export async function resolveRecipient(input, { readEnsText, readGweiText } = {}) {
  if (typeof input !== 'string' || input.trim() !== input || input.length === 0) {
    fail('INVALID_RECIPIENT', 'recipient must be a non-empty string without surrounding whitespace')
  }
  if (input.startsWith('blobmail:')) {
    const contact = await parseContactCode(input)
    return Object.freeze({ ...contact, source: 'contact-code', evidence: Object.freeze([]) })
  }

  const lower = input.toLowerCase()
  let source
  let observation
  if (lower.endsWith('.eth')) {
    if (typeof readEnsText !== 'function') fail('RESOLVER_UNAVAILABLE', '.eth resolution is unavailable')
    source = 'ens'
    observation = await readEnsText(input, BLOBMAIL_TEXT_RECORD_KEY)
  } else if (lower.endsWith('.gwei')) {
    if (typeof readGweiText !== 'function') fail('RESOLVER_UNAVAILABLE', '.gwei resolution is unavailable')
    source = 'gns'
    observation = await readGweiText(input, BLOBMAIL_TEXT_RECORD_KEY)
  } else {
    fail('UNSUPPORTED_RECIPIENT', 'recipient must be a BlobMail contact code, .eth name, or .gwei name')
  }
  if (!observation || typeof observation.value !== 'string' || observation.value.length === 0) {
    fail('BLOBMAIL_RECORD_NOT_FOUND', `${input} has no ${BLOBMAIL_TEXT_RECORD_KEY} record`)
  }
  let contact
  try {
    contact = await parseContactCode(observation.value)
  } catch (cause) {
    throw new RecipientResolutionError('INVALID_BLOBMAIL_RECORD', `${input} has an invalid BlobMail contact record`, {
      cause: cause?.message ?? 'unknown',
    })
  }
  return Object.freeze({
    ...contact,
    source,
    name: observation.normalizedName,
    evidence: Object.freeze([Object.freeze({
      code: 'RECIPIENT_RECORD_RESOLVED',
      source,
      name: observation.normalizedName,
      recordKey: BLOBMAIL_TEXT_RECORD_KEY,
      chainId: String(observation.chainId),
      blockNumber: String(observation.blockNumber),
      resolverAddress: observation.resolverAddress,
    })]),
  })
}

export async function buildTextRecordUpdate(name, contactCode, reader) {
  const parsed = await parseContactCode(contactCode)
  const lower = String(name).toLowerCase()
  if (lower.endsWith('.eth')) {
    const observation = await reader.readEnsText(name, BLOBMAIL_TEXT_RECORD_KEY)
    return Object.freeze({
      source: 'ens',
      chainId: observation.chainId,
      to: observation.resolverAddress,
      data: encodeFunctionData({
        abi: TEXT_WRITER_ABI,
        functionName: 'setText',
        args: [observation.node, BLOBMAIL_TEXT_RECORD_KEY, parsed.contactCode],
      }),
      value: 0n,
    })
  }
  if (lower.endsWith('.gwei')) {
    const observation = await reader.readGweiText(name, BLOBMAIL_TEXT_RECORD_KEY)
    return Object.freeze({
      source: 'gns',
      chainId: observation.chainId,
      to: observation.contractAddress,
      data: encodeFunctionData({
        abi: GNS_TEXT_WRITER_ABI,
        functionName: 'setText',
        args: [BigInt(observation.node), BLOBMAIL_TEXT_RECORD_KEY, parsed.contactCode],
      }),
      value: 0n,
    })
  }
  fail('UNSUPPORTED_RECIPIENT', 'record updates require a .eth or .gwei name')
}
