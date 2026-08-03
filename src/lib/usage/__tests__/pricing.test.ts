import test from 'node:test'
import assert from 'node:assert/strict'
import { computeCostUsd, PRICE_VERSION } from '@/lib/usage/pricing'

const MILLION_INPUT = { inputTokens: 1_000_000, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }

test('a known model prices input tokens from the table', () => {
  const result = computeCostUsd('anthropic', 'claude-sonnet-5', MILLION_INPUT)
  assert.equal(result.priceVersion, PRICE_VERSION)
  assert.equal(result.costUsd, 3)
})

test('published per-million rates match the current price sheet', () => {
  const output = (model: string) =>
    computeCostUsd('anthropic', model, {
      inputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 1_000_000,
    }).costUsd
  const input = (model: string) => computeCostUsd('anthropic', model, MILLION_INPUT).costUsd

  // Opus 5 is $5/$25 — NOT the $15/$75 of the Opus 3 era.
  assert.equal(input('claude-opus-5'), 5)
  assert.equal(output('claude-opus-5'), 25)
  assert.equal(input('claude-sonnet-5'), 3)
  assert.equal(output('claude-sonnet-5'), 15)
  assert.equal(input('claude-haiku-4-5'), 1)
  assert.equal(output('claude-haiku-4-5'), 5)
  assert.equal(input('claude-fable-5'), 10)
  assert.equal(output('claude-fable-5'), 50)
})

test('cache reads cost far less than fresh input for the same token count', () => {
  const fresh = computeCostUsd('anthropic', 'claude-sonnet-5', MILLION_INPUT)
  const cached = computeCostUsd('anthropic', 'claude-sonnet-5', {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 1_000_000,
    outputTokens: 0,
  })
  assert.ok(cached.costUsd < fresh.costUsd / 5, 'cache reads must be dramatically cheaper')
  assert.equal(cached.costUsd, 0.3) // 0.1x of $3
})

test('cache writes cost more than fresh input for the same token count', () => {
  const written = computeCostUsd('anthropic', 'claude-sonnet-5', {
    inputTokens: 0,
    cacheWriteTokens: 1_000_000,
    cacheReadTokens: 0,
    outputTokens: 0,
  })
  assert.equal(written.costUsd, 3.75) // 1.25x of $3
})

test('a dated model variant prices as its family via longest-prefix match', () => {
  const dated = computeCostUsd('anthropic', 'claude-sonnet-5-20260101', MILLION_INPUT)
  assert.equal(dated.costUsd, 3)
  assert.equal(dated.priceVersion, PRICE_VERSION)
})

test('an unknown model costs zero and is flagged rather than throwing', () => {
  const result = computeCostUsd('anthropic', 'claude-model-from-the-future', MILLION_INPUT)
  assert.equal(result.costUsd, 0)
  assert.equal(result.priceVersion, 'unknown')
})

test('embedding models price input only', () => {
  const result = computeCostUsd('voyage', 'voyage-3', {
    inputTokens: 1_000_000,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 5_000,
  })
  assert.equal(result.costUsd, 0.06)
  assert.equal(result.priceVersion, PRICE_VERSION)
})

test('cost is rounded to six decimal places to match the Decimal(12,6) column', () => {
  const result = computeCostUsd('anthropic', 'claude-sonnet-5', {
    inputTokens: 1,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  })
  const decimals = String(result.costUsd).split('.')[1] ?? ''
  assert.ok(decimals.length <= 6, `expected <=6 decimals, got ${result.costUsd}`)
})
