import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { shadowConfig, shouldSample } from '../shadow'
import { resolveBenchModels } from '../bench'
import { pinnedJudgeModel } from '../judge'

/**
 * The pure decision rules behind the Quality panel. What matters most is the
 * OFF state: shadowing spends tenant-adjacent tokens on every sampled step, so
 * any ambiguity in the config must resolve to "do nothing".
 */

const env = { ...process.env }
beforeEach(() => {
  process.env = { ...env }
})

test('shadowing is off until BOTH model and a positive rate are set', () => {
  assert.equal(shadowConfig({ rate: undefined, model: undefined }), null)
  assert.equal(shadowConfig({ rate: '0.1', model: undefined }), null)
  assert.equal(shadowConfig({ rate: undefined, model: 'qwen-3.7' }), null)
  assert.equal(shadowConfig({ rate: '0', model: 'qwen-3.7' }), null)
  assert.equal(shadowConfig({ rate: '-1', model: 'qwen-3.7' }), null)
  assert.equal(shadowConfig({ rate: 'lots', model: 'qwen-3.7' }), null)
  assert.deepEqual(shadowConfig({ rate: '0.05', model: 'qwen-3.7' }), { rate: 0.05, model: 'qwen-3.7' })
})

test('a fat-fingered rate clamps to sampling everything, not 500%', () => {
  assert.deepEqual(shadowConfig({ rate: '5', model: 'qwen-3.7' }), { rate: 1, model: 'qwen-3.7' })
})

test('sampling is a strict threshold on the roll', () => {
  assert.equal(shouldSample(0.05, 0.049), true)
  assert.equal(shouldSample(0.05, 0.05), false)
  assert.equal(shouldSample(1, 0.999), true)
})

test('bench candidates come from BENCH_MODELS, filtered to configured endpoints', () => {
  assert.deepEqual(
    resolveBenchModels({ env: 'claude-sonnet-5, qwen-3.7', anthropic: true, qwen: true }),
    ['claude-sonnet-5', 'qwen-3.7'],
  )
  // An unconfigured endpoint drops its candidates rather than failing the run.
  assert.deepEqual(
    resolveBenchModels({ env: 'claude-sonnet-5,qwen-3.7', anthropic: true, qwen: false }),
    ['claude-sonnet-5'],
  )
  assert.deepEqual(resolveBenchModels({ env: 'qwen-3.7', anthropic: true, qwen: false }), [])
  // Duplicates collapse so a model is not benched (and billed) twice.
  assert.deepEqual(
    resolveBenchModels({ env: 'qwen-3.7,qwen-3.7', anthropic: false, qwen: true }),
    ['qwen-3.7'],
  )
})

test('an explicit selection beats BENCH_MODELS, and still drops unconfigured endpoints', () => {
  // The panel's chips are the selection; the env var stays the CLI/default
  // source. Endpoint filtering applies to BOTH — a stale queued selection must
  // never make the worker call an endpoint it has no key for.
  assert.deepEqual(
    resolveBenchModels({ env: 'claude-opus-4-8', anthropic: true, qwen: true, selection: ['claude-haiku-4-5', 'qwen-3.7'] }),
    ['claude-haiku-4-5', 'qwen-3.7'],
  )
  assert.deepEqual(
    resolveBenchModels({ env: 'claude-opus-4-8', anthropic: true, qwen: false, selection: ['claude-haiku-4-5', 'qwen-3.7'] }),
    ['claude-haiku-4-5'],
  )
  // An empty selection is "no selection", not "bench nothing".
  assert.deepEqual(
    resolveBenchModels({ env: 'claude-opus-4-8', anthropic: true, qwen: true, selection: [] }),
    ['claude-opus-4-8'],
  )
})

test('the benchable roster is the picker contract: configured endpoints only, extras included once', async () => {
  const { benchableCandidates } = await import('../bench')
  assert.deepEqual(benchableCandidates({ anthropic: true, qwen: true }), [
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-haiku-4-5',
    'qwen-3.7',
  ])
  assert.deepEqual(benchableCandidates({ anthropic: false, qwen: true }), ['qwen-3.7'])
  // BENCH_MODELS extends the roster (a dated variant) without duplicating it.
  assert.deepEqual(
    benchableCandidates({ anthropic: true, qwen: false, extra: ['claude-sonnet-5', 'claude-opus-4-7'] }),
    ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-opus-4-7'],
  )
})

test('the default candidate set covers both endpoints when configured', () => {
  delete process.env.AGENT_MODEL
  const models = resolveBenchModels({ env: undefined, anthropic: true, qwen: true })
  assert.ok(models.some((model) => model.startsWith('claude')))
  assert.ok(models.includes('qwen-3.7'))
})

test('the judge is pinned: override first, Claude when available, Qwen last', () => {
  process.env.BENCH_JUDGE_MODEL = 'claude-opus-4-8'
  assert.equal(pinnedJudgeModel(), 'claude-opus-4-8')

  delete process.env.BENCH_JUDGE_MODEL
  process.env.ANTHROPIC_API_KEY = 'key'
  assert.equal(pinnedJudgeModel(), 'claude-sonnet-5')

  delete process.env.ANTHROPIC_API_KEY
  process.env.QWEN_MODEL = 'qwen3-max'
  assert.equal(pinnedJudgeModel(), 'qwen3-max')
})

test('benchErrorDetail surfaces the provider body, not just the SDK line', async () => {
  const { benchErrorDetail } = await import('../bench')
  // The shape DashScope's refusal actually arrived in: a terse SDK message
  // with the reason buried in the parsed body.
  const refusal = Object.assign(new Error('403 event:error'), {
    error: { error: { code: 'AccessDenied', message: 'The free quota has been exhausted.' } },
  })
  assert.equal(benchErrorDetail(refusal), '403 event:error — The free quota has been exhausted.')
  // Flat body shape, plain errors, and non-errors all still read sensibly.
  const flat = Object.assign(new Error('400 bad request'), { error: { message: 'unknown model' } })
  assert.equal(benchErrorDetail(flat), '400 bad request — unknown model')
  assert.equal(benchErrorDetail(new Error('plain failure')), 'plain failure')
  assert.equal(benchErrorDetail('string error'), 'string error')
})
