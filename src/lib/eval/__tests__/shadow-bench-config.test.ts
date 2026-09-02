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

test('bench candidates come from BENCH_MODELS, filtered to the configured endpoint', () => {
  assert.deepEqual(
    resolveBenchModels({ env: 'claude-sonnet-5, claude-haiku-4-5', anthropic: true }),
    ['claude-sonnet-5', 'claude-haiku-4-5'],
  )
  // Candidates for removed endpoints drop rather than failing the run.
  assert.deepEqual(
    resolveBenchModels({ env: 'claude-sonnet-5,qwen-3.7', anthropic: true }),
    ['claude-sonnet-5'],
  )
  assert.deepEqual(resolveBenchModels({ env: 'qwen-3.7', anthropic: true }), [])
  // Duplicates collapse so a model is not benched (and billed) twice.
  assert.deepEqual(
    resolveBenchModels({ env: 'claude-sonnet-5,claude-sonnet-5', anthropic: true }),
    ['claude-sonnet-5'],
  )
})

test('an explicit selection beats BENCH_MODELS, and still drops removed endpoints', () => {
  // The panel's chips are the selection; the env var stays the CLI/default
  // source. Endpoint filtering applies to BOTH — a stale queued selection must
  // never make the worker call an endpoint it has no key for.
  assert.deepEqual(
    resolveBenchModels({ env: 'claude-opus-4-8', anthropic: true, selection: ['claude-haiku-4-5', 'qwen-3.7'] }),
    ['claude-haiku-4-5'],
  )
  // An empty selection is "no selection", not "bench nothing".
  assert.deepEqual(
    resolveBenchModels({ env: 'claude-opus-4-8', anthropic: true, selection: [] }),
    ['claude-opus-4-8'],
  )
})

test('the benchable roster is the picker contract: configured endpoints only, extras included once', async () => {
  const { benchableCandidates } = await import('../bench')
  assert.deepEqual(benchableCandidates({ anthropic: true }), [
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-haiku-4-5',
  ])
  assert.deepEqual(benchableCandidates({ anthropic: false }), [])
  // BENCH_MODELS extends the roster (a dated variant) without duplicating it.
  assert.deepEqual(
    benchableCandidates({ anthropic: true, extra: ['claude-sonnet-5', 'claude-opus-4-7'] }),
    ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5', 'claude-opus-4-7'],
  )
})

test('the default candidate set is the default agent model', () => {
  delete process.env.AGENT_MODEL
  const models = resolveBenchModels({ env: undefined, anthropic: true })
  assert.ok(models.length >= 1)
  assert.ok(models.every((model) => model.startsWith('claude')))
})

test('the judge is pinned: override first, Claude otherwise', () => {
  process.env.BENCH_JUDGE_MODEL = 'claude-opus-4-8'
  assert.equal(pinnedJudgeModel(), 'claude-opus-4-8')

  delete process.env.BENCH_JUDGE_MODEL
  assert.equal(pinnedJudgeModel(), 'claude-sonnet-5')
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

test('live runs are fed the script-authored tool results, not bare ok:true', async () => {
  const { fixtureDispatch } = await import('../harness')
  const { fixtures } = await import('../fixtures')
  const nudge = fixtures.find((fixture) => fixture.name === 'slack-renewal-nudge')
  assert.ok(nudge)
  const dispatch = fixtureDispatch(nudge)

  // The account lookup must return the authored renewal data. The first prod
  // bench served {ok:true} here, which starved careful models of the renewal
  // date and scored them below the model willing to fabricate one.
  const lookup = await dispatch({ id: '1', name: 'backstory_get_account', input: { account: 'ACME' } }, 0)
  assert.ok(lookup.content.includes('renewalDate'), `lookup got: ${lookup.content}`)
  assert.equal(lookup.isError, false)

  // A re-lookup sees the same world, not a different one.
  const again = await dispatch({ id: '2', name: 'backstory_get_account', input: { account: 'ACME' } }, 1)
  assert.equal(again.content, lookup.content)

  // A tool the script never calls still gets the benign fallback.
  const unknown = await dispatch({ id: '3', name: 'some_other_tool', input: {} }, 1)
  assert.equal(unknown.content, JSON.stringify({ ok: true }))
})
