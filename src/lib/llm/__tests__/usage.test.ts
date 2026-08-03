import test from 'node:test'
import assert from 'node:assert/strict'
import { billableTokens, emptyUsage } from '@/lib/llm/model-runner'

test('billableTokens counts every input bucket plus output', () => {
  assert.equal(
    billableTokens({ inputTokens: 100, cacheWriteTokens: 40, cacheReadTokens: 900, outputTokens: 60 }),
    1100,
  )
})

test('billableTokens matches the pre-split total so budget enforcement is unchanged', () => {
  // Before the split, inputTokens was input+cacheWrite+cacheRead and callers
  // summed it with outputTokens. This must still produce the same number.
  const legacyInput = 100 + 40 + 900
  assert.equal(
    billableTokens({ inputTokens: 100, cacheWriteTokens: 40, cacheReadTokens: 900, outputTokens: 60 }),
    legacyInput + 60,
  )
})

test('emptyUsage is all zeros', () => {
  assert.deepEqual(emptyUsage(), {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  })
})
