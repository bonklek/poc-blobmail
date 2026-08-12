import assert from 'node:assert/strict'
import test from 'node:test'

import { encodeAbiParameters, encodeEventTopics, getAddress } from 'viem'

import {
  BLOBMAIL_CONTENT_TAG,
  BSS_ABI,
  SEPOLIA_BSS_CONTRACT,
  discoverBlobMailSegments,
} from '../src/segments/index.js'

const TX_HASH = `0x${'11'.repeat(32)}`
const BLOCK_HASH = `0x${'22'.repeat(32)}`
const VERSIONED_HASH = `0x01${'33'.repeat(31)}`
const DECLARER = getAddress(`0x${'44'.repeat(20)}`)

function eventLog(overrides = {}) {
  const topics = encodeEventTopics({
    abi: BSS_ABI,
    eventName: 'BlobSegmentDeclared',
    args: {
      versionedHash: VERSIONED_HASH,
      declarer: DECLARER,
      startFE: 3,
      endFE: 25,
      contentTag: BLOBMAIL_CONTENT_TAG,
    },
  })
  const data = encodeAbiParameters([{ type: 'uint16' }, { type: 'uint16' }], [3, 25])
  return {
    address: SEPOLIA_BSS_CONTRACT,
    topics,
    data,
    transactionHash: TX_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: '0x64',
    logIndex: '0x2',
    removed: false,
    ...overrides,
  }
}

test('discovery uses a bounded pinned filter and returns a reorg anchor', async () => {
  const calls = []
  const result = await discoverBlobMailSegments({
    fromBlock: 100,
    confirmations: 2,
    maxBlocks: 20,
    requestRpc: async (method, params) => {
      calls.push({ method, params })
      if (method === 'eth_chainId') return '0xaa36a7'
      if (method === 'eth_blockNumber') return '0x78'
      if (method === 'eth_getLogs') return [eventLog()]
      if (method === 'eth_getBlockByNumber') return { number: '0x76', hash: BLOCK_HASH }
      throw new Error('unexpected')
    },
  })

  assert.deepEqual(result.scanned, { fromBlock: 100, toBlock: 118 })
  assert.equal(result.nextBlock, 119)
  assert.deepEqual(result.anchor, { blockNumber: 118, blockHash: BLOCK_HASH })
  assert.equal(result.declarations[0].versionedHash, VERSIONED_HASH)
  assert.equal(result.declarations[0].transactionHash, TX_HASH)
  const filter = calls.find(({ method }) => method === 'eth_getLogs').params[0]
  assert.equal(filter.address, SEPOLIA_BSS_CONTRACT)
  assert.equal(filter.fromBlock, '0x64')
  assert.equal(filter.toBlock, '0x76')
  assert.deepEqual(filter.topics, encodeEventTopics({
    abi: BSS_ABI,
    eventName: 'BlobSegmentDeclared',
    args: { contentTag: BLOBMAIL_CONTENT_TAG },
  }))
})

test('discovery rejects a changed anchor before requesting logs', async () => {
  const methods = []
  await assert.rejects(() => discoverBlobMailSegments({
    fromBlock: 101,
    anchor: { blockNumber: 100, blockHash: BLOCK_HASH },
    requestRpc: async (method) => {
      methods.push(method)
      if (method === 'eth_chainId') return '0xaa36a7'
      if (method === 'eth_blockNumber') return '0x80'
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: `0x${'99'.repeat(32)}` }
      throw new Error('unexpected')
    },
  }), { code: 'REORG_DETECTED' })
  assert.equal(methods.includes('eth_getLogs'), false)
})

test('discovery does not scan unconfirmed blocks', async () => {
  const result = await discoverBlobMailSegments({
    fromBlock: 200,
    confirmations: 4,
    requestRpc: async (method) => {
      if (method === 'eth_chainId') return '0xaa36a7'
      if (method === 'eth_blockNumber') return '0xcb'
      throw new Error('unexpected')
    },
  })
  assert.equal(result.scanned, null)
  assert.equal(result.nextBlock, 200)
})
