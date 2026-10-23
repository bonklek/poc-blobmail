import assert from 'node:assert/strict'
import test from 'node:test'

import { initialMailboxBlock } from '../src/mvp/main.js'

test('first mailbox setup derives the cursor from a canonical head block number', () => {
  assert.equal(initialMailboxBlock('0x2'), 1)
  assert.equal(initialMailboxBlock('0x96f3a1'), 0x96f3a0)
  assert.equal(initialMailboxBlock('0X96F3A1'), 0x96f3a0)
})

test('first mailbox setup rejects malformed, unsafe, or implausible head block numbers', () => {
  for (const head of [
    undefined, null, 9_900_000, '', '0x', '9900000', '0x00ff', '-0x5', '0xzz', ' 0x10',
    `0x${(2n ** 53n).toString(16)}`, '0x0', '0x1',
  ]) {
    assert.throws(() => initialMailboxBlock(head), /head block number/u, String(head))
  }
})
