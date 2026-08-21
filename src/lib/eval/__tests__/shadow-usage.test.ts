import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shadowUsageFields } from '../shadow'

/**
 * Regression for the champion-row-stores-zeros bug: the challenger's shadow
 * row always carried its real usage, but the champion row next to it was
 * built with the field simply omitted, which Prisma defaults to 0 — champion
 * spend was invisible and any aggregation over shadow rows was half-empty.
 * shadowUsageFields is the one function both sides now go through, so a
 * champion-shaped call must return the same real numbers a challenger-shaped
 * call would.
 */

test('shadowUsageFields turns real usage into real tokens/cost/latency — never defaults', () => {
  const usage = { inputTokens: 1000, cacheReadTokens: 200, cacheWriteTokens: 50, outputTokens: 400 }
  const fields = shadowUsageFields(usage, 'anthropic', 'claude-sonnet-5', 1234)

  assert.equal(fields.inputTokens, 1250) // input + cacheRead + cacheWrite
  assert.equal(fields.outputTokens, 400)
  assert.equal(fields.latencyMs, 1234)
  assert.ok(fields.costUsd > 0, 'a priced model must produce nonzero cost from real usage')
})

test('shadowUsageFields is the same function for champion and challenger shapes — no special-cased zeroing', () => {
  const usage = { inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 100 }
  const championFields = shadowUsageFields(usage, 'anthropic', 'claude-sonnet-5', 500)
  const challengerFields = shadowUsageFields(usage, 'anthropic', 'claude-sonnet-5', 500)
  assert.deepEqual(championFields, challengerFields)
  assert.notEqual(championFields.inputTokens, 0)
  assert.notEqual(championFields.costUsd, 0)
})

test('an unpriced model still returns real token counts, cost just falls back to 0', () => {
  const usage = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 }
  const fields = shadowUsageFields(usage, 'anthropic', 'not-a-real-model', 42)
  assert.equal(fields.inputTokens, 100)
  assert.equal(fields.outputTokens, 50)
  assert.equal(fields.latencyMs, 42)
  assert.equal(fields.costUsd, 0)
})
