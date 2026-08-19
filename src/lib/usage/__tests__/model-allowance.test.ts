import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { MODEL_LIMITS, downgradeNotice, modelTier } from '../model-allowance'
import { routeModel } from '@/lib/llm/model-runner'

/**
 * The ceilings are enforced by ROUTING, so what has to be pinned is which
 * endpoint chain a spent allowance produces — not a boolean somewhere. The
 * failure mode that matters most is a cap that refuses instead of redirecting,
 * which would turn a cost control into an outage.
 */

const env = { ...process.env }
beforeEach(() => {
  process.env = { ...env }
  process.env.ANTHROPIC_API_KEY = 'test-key'
  process.env.QWEN_API_KEY = 'test-key'
  process.env.QWEN_BASE_URL = 'https://example.invalid/anthropic'
  delete process.env.QWEN_MODEL
  delete process.env.AGENT_MODEL
})

const ALL = { frontier: true, claude: true }
const NO_FRONTIER = { frontier: false, claude: true }
const NO_CLAUDE = { frontier: false, claude: false }

test('tiers split frontier Claude from the rest of the family', () => {
  assert.equal(modelTier('claude-opus-4-8'), 'frontier')
  assert.equal(modelTier('claude-fable-5'), 'frontier')
  assert.equal(modelTier('claude-mythos-5'), 'frontier')
  assert.equal(modelTier('claude-sonnet-5'), 'claude')
  assert.equal(modelTier('claude-haiku-4-5'), 'claude')
  assert.equal(modelTier('qwen-3.7'), 'open')
})

test('a full allowance routes exactly as before', () => {
  assert.deepEqual(routeModel('claude-opus-4-8', ALL), [
    { target: 'claude', model: 'claude-opus-4-8' },
    { target: 'qwen', model: 'qwen-3.7' },
  ])
})

test('a spent frontier allowance downgrades to Sonnet but stays on Claude', () => {
  const chain = routeModel('claude-opus-4-8', NO_FRONTIER)
  assert.deepEqual(chain[0], { target: 'claude', model: 'claude-sonnet-5' })
  assert.equal(chain.some((step) => modelTier(step.model) === 'frontier'), false)
})

test('the frontier cap also holds the cross-endpoint fallback down', () => {
  // Qwen unconfigured, so the chain is Claude-only and appends a second Claude
  // step — which defaults to Opus and would hand the cap straight back.
  delete process.env.QWEN_API_KEY
  delete process.env.QWEN_BASE_URL
  const chain = routeModel('claude-sonnet-5', NO_FRONTIER)
  assert.equal(chain.some((step) => modelTier(step.model) === 'frontier'), false)
})

test('a spent Claude allowance leaves Qwen as the only endpoint', () => {
  assert.deepEqual(routeModel('claude-opus-4-8', NO_CLAUDE), [{ target: 'qwen', model: 'qwen-3.7' }])
})

test('Claude is dropped from the chain entirely, not just from first place', () => {
  // Keeping it as the fallback would send every Qwen overload straight back to
  // the endpoint the ceiling exists to relieve.
  const chain = routeModel('claude-sonnet-5', NO_CLAUDE)
  assert.equal(chain.some((step) => step.target === 'claude'), false)
})

test('caps never refuse: with no Qwen endpoint they do not apply at all', () => {
  delete process.env.QWEN_API_KEY
  delete process.env.QWEN_BASE_URL
  const chain = routeModel('claude-opus-4-8', NO_CLAUDE)
  assert.ok(chain.length > 0, 'an unset env var must not stop every run in the workspace')
  assert.equal(chain[0].model, 'claude-opus-4-8')
})

test('a Qwen run is unaffected by Claude ceilings', () => {
  assert.deepEqual(routeModel('qwen-3.7', NO_CLAUDE), [{ target: 'qwen', model: 'qwen-3.7' }])
})

test('the notice names the limit and says when it lifts', () => {
  assert.equal(downgradeNotice('claude-sonnet-5', 'claude-sonnet-5'), null)

  const frontier = downgradeNotice('claude-opus-4-8', 'claude-sonnet-5')
  assert.ok(frontier?.includes(String(MODEL_LIMITS.frontierClaudeRunsPerDay)))
  assert.ok(frontier?.includes('claude-sonnet-5'))
  assert.ok(frontier?.includes('midnight UTC'))

  const spent = downgradeNotice('claude-opus-4-8', 'qwen-3.7')
  assert.ok(spent?.includes(String(MODEL_LIMITS.claudeRunsPerDay)))
  assert.ok(spent?.includes('qwen-3.7'))
})
