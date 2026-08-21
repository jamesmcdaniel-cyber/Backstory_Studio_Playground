import test from 'node:test'
import assert from 'node:assert/strict'
import { accumulateUsage, billableTokens, emptyUsage } from '@/lib/llm/model-runner'

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

test('accumulateUsage keeps cache buckets separate from inputTokens -- a cache-heavy turn must not inflate fresh input', () => {
  const total = emptyUsage()
  accumulateUsage(total, { inputTokens: 100, cacheWriteTokens: 40, cacheReadTokens: 900, outputTokens: 60 })
  assert.equal(total.inputTokens, 100, 'inputTokens must stay fresh-input only, not folded with cache reads/writes')
  assert.equal(total.cacheReadTokens, 900)
  assert.equal(total.cacheWriteTokens, 40)
  assert.equal(total.outputTokens, 60)
})

test('accumulateUsage sums across multiple turns', () => {
  const total = emptyUsage()
  accumulateUsage(total, { inputTokens: 100, cacheWriteTokens: 40, cacheReadTokens: 900, outputTokens: 60 })
  accumulateUsage(total, { inputTokens: 10, cacheWriteTokens: 5, cacheReadTokens: 20, outputTokens: 15 })
  assert.deepEqual(total, { inputTokens: 110, cacheWriteTokens: 45, cacheReadTokens: 920, outputTokens: 75 })
})

test('accumulateUsage total still matches billableTokens (budget enforcement unchanged)', () => {
  const total = emptyUsage()
  accumulateUsage(total, { inputTokens: 100, cacheWriteTokens: 40, cacheReadTokens: 900, outputTokens: 60 })
  assert.equal(billableTokens(total), 1100)
})
