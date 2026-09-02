import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_LIMITS, downgradeNotice, modelTier } from '../model-tiers'
import { routeModel } from '@/lib/llm/model-runner'

/**
 * The ceilings used to be enforced by ROUTING: a spent allowance redirected to
 * the Qwen endpoint. That endpoint was removed, and with nowhere to redirect
 * the ceilings are deliberately dormant — an unenforceable cap must not become
 * an outage. What is pinned now is the single-endpoint chain itself: primary
 * model first, a different Claude model appended as the overload fallback.
 */

const env = { ...process.env }
beforeEach(() => {
  process.env = { ...env }
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.AGENT_MODEL
})

test('tiers still split frontier Claude from the rest of the family', () => {
  assert.equal(modelTier('claude-opus-4-8'), 'frontier')
  assert.equal(modelTier('claude-fable-5'), 'frontier')
  assert.equal(modelTier('claude-mythos-5'), 'frontier')
  assert.equal(modelTier('claude-sonnet-5'), 'claude')
  assert.equal(modelTier('claude-haiku-4-5'), 'claude')
})

test('a Claude model routes to itself with the overload fallback appended', () => {
  assert.deepEqual(routeModel('claude-sonnet-5'), [
    { target: 'claude', model: 'claude-sonnet-5' },
    { target: 'claude', model: 'claude-opus-4-8' },
  ])
})

test('the fallback model gets no duplicate step', () => {
  assert.deepEqual(routeModel('claude-opus-4-8'), [{ target: 'claude', model: 'claude-opus-4-8' }])
})

test('a non-Claude model lands on the Claude fallback rather than failing', () => {
  const chain = routeModel('qwen-3.7')
  assert.ok(chain.length >= 1)
  assert.ok(chain.every((step) => step.target === 'claude'))
  assert.equal(chain[0].model, 'claude-opus-4-8')
})

test('no key configured routes nowhere', () => {
  delete process.env.ANTHROPIC_API_KEY
  assert.deepEqual(routeModel('claude-sonnet-5'), [])
})

test('downgradeNotice still names both models when a served model differs', () => {
  const note = downgradeNotice('claude-opus-4-8', 'claude-sonnet-5')
  assert.ok(note)
  assert.match(note!, /claude-opus-4-8/)
  assert.match(note!, /claude-sonnet-5/)
  assert.equal(downgradeNotice('claude-sonnet-5', 'claude-sonnet-5'), null)
})

test('MODEL_LIMITS remain defined for the day the ceilings get a lever again', () => {
  assert.ok(MODEL_LIMITS)
})
