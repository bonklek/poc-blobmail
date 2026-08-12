import assert from 'node:assert/strict'
import test from 'node:test'

import { encodeFunctionResult } from 'viem'
import { deriveIdentity } from '../src/protocol/index.js'
import {
  ENS_REGISTRY_ADDRESS,
  ETHEREUM_MAINNET_CHAIN_ID,
  GNS_NAME_NFT_ADDRESS,
  createContactCode,
  createEthereumTextRecordReader,
  resolveRecipient,
} from '../src/identity/index.js'

const REGISTRY_RESULT_ABI = [{
  type: 'function', name: 'resolver', stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }],
}]
const TEXT_RESULT_ABI = [{
  type: 'function', name: 'text', stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
  outputs: [{ name: '', type: 'string' }],
}]

test('Ethereum reader verifies chain context and resolves ENS and GNS text records', async () => {
  const identity = await deriveIdentity(Uint8Array.from({ length: 32 }, (_, index) => 255 - index))
  const contactCode = await createContactCode(identity.publicKeyBytes)
  const ensResolver = '0x1111111111111111111111111111111111111111'
  const calls = []
  const request = async ({ method, params }) => {
    calls.push({ method, params })
    if (method === 'eth_chainId') return '0x1'
    if (method === 'eth_blockNumber') return '0xabc'
    const to = params[0].to.toLowerCase()
    if (to === ENS_REGISTRY_ADDRESS.toLowerCase()) {
      return encodeFunctionResult({ abi: REGISTRY_RESULT_ABI, functionName: 'resolver', result: ensResolver })
    }
    if (to === ensResolver.toLowerCase() || to === GNS_NAME_NFT_ADDRESS.toLowerCase()) {
      return encodeFunctionResult({ abi: TEXT_RESULT_ABI, functionName: 'text', result: contactCode })
    }
    throw new Error(`unexpected target ${to}`)
  }
  const reader = createEthereumTextRecordReader({ request, expectedChainId: ETHEREUM_MAINNET_CHAIN_ID })
  const ens = await resolveRecipient('alice.eth', reader)
  const gns = await resolveRecipient('alice.gwei', reader)

  assert.equal(ens.identityId, identity.identityId)
  assert.equal(gns.identityId, identity.identityId)
  assert.equal(ens.evidence[0].blockNumber, '2748')
  assert.ok(calls.some(({ method }) => method === 'eth_call'))
  assert.ok(calls.filter(({ method }) => method === 'eth_call').every(({ params }) => params[1] === '0xabc'))
})

test('Ethereum reader rejects wrong chains before accepting record data', async () => {
  const reader = createEthereumTextRecordReader({
    expectedChainId: ETHEREUM_MAINNET_CHAIN_ID,
    request: async ({ method }) => method === 'eth_chainId' ? '0xaa36a7' : '0x1',
  })
  await assert.rejects(
    reader.readGweiText('alice.gwei'),
    (error) => error.code === 'CHAIN_ID_MISMATCH',
  )
})
