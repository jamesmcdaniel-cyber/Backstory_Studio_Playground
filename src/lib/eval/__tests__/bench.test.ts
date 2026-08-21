import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { runBench, meanJudgement } from '../bench'
import { CURRENT_HARNESS_VERSION } from '../harness'
import type { LedgerContext, ModelRunner, ModelTurn } from '@/lib/llm/model-runner'
import type { JudgeResult, Trajectory } from '../types'
import { fixtures } from '../fixtures'

/**
 * Bench evidence: spend is ledgered, rows are harness-versioned, and the
 * stored score has per-sample evidence behind it. All against fakes (no
 * network, no DB) — createRunner/prisma/judge are injectable exactly for this.
 */

const env = { ...process.env }
beforeEach(() => {
  process.env = { ...env }
  process.env.ANTHROPIC_API_KEY = 'test-key'
})

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens }
}

/** A ModelRunner whose next() records the ledger it was called with and returns one final answer. */
function makeSucceedingRunner(turn: ModelTurn, ledgersSeen: (LedgerContext | undefined)[]): ModelRunner {
  return {
    model: 'fake',
    start: (input: string) => [{ role: 'user', content: input }],
    appendUserMessage() {},
    appendToolResults() {},
    async next(_t: unknown[], _s: string, _tools: unknown[], ledger?: LedgerContext) {
      ledgersSeen.push(ledger)
      return turn
    },
  } as ModelRunner
}

/** A fake judge that records the ledger it was called with and always returns the same verdict. */
function makeFakeJudge(verdict: JudgeResult, ledgersSeen: (LedgerContext | undefined)[]) {
  return async (_rubric: string, _trajectory: Trajectory, opts?: { judgeModel?: string; ledger?: LedgerContext }): Promise<JudgeResult> => {
    ledgersSeen.push(opts?.ledger)
    return verdict
  }
}

const oneRubricFixture = fixtures.find((f) => f.rubric)
assert.ok(oneRubricFixture, 'at least one fixture must carry a rubric for bench to exercise')

test('meanJudgement samples exactly 3 times, score is their mean, and samples holds all 3 {score,reasoning}', async () => {
  const scores = [0.2, 0.8, 0.5]
  let call = 0
  const judge = async (): Promise<JudgeResult> => {
    const score = scores[call]
    call += 1
    return { pass: score > 0.5, score, reasoning: `sample ${call}` }
  }
  const trajectory: Trajectory = {
    finalText: 'x',
    turns: [],
    toolsCalled: [],
    toolErrors: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    rawUsage: { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 },
    hitMaxTurns: false,
  }
  const result = await meanJudgement('rubric', trajectory, { judge })
  assert.equal(result.samples.length, 3)
  assert.deepEqual(
    result.samples.map((s) => s.score),
    scores,
  )
  const expectedMean = scores.reduce((t, s) => t + s, 0) / scores.length
  assert.equal(result.score, expectedMean)
  // The old bug: the LAST sample's reasoning was kept next to the mean with
  // nothing showing where the mean came from. `samples` is what fixes that —
  // `reasoning` may still be the last one for the one-line summary.
  assert.equal(result.reasoning, 'sample 3')
})

test('runBench threads a ledger (surface eval_bench, given organizationId) into both the runner loop and the judge', async () => {
  const runnerLedgers: (LedgerContext | undefined)[] = []
  const judgeLedgers: (LedgerContext | undefined)[] = []
  const created: Record<string, unknown>[] = []

  await runBench({
    models: ['claude-sonnet-5'],
    organizationId: 'org-123',
    log: () => undefined,
    createRunner: () => makeSucceedingRunner({ text: 'ok', toolCalls: [], usage: usage(10, 5), provider: 'anthropic', servedModel: 'claude-sonnet-5', latencyMs: 3 }, runnerLedgers),
    judge: makeFakeJudge({ pass: true, score: 0.9, reasoning: 'good' }, judgeLedgers),
    prisma: { modelEvalResult: { create: async (args) => created.push(args.data) } },
  })

  assert.ok(runnerLedgers.length > 0, 'the runner loop must have been called')
  for (const ledger of runnerLedgers) assert.deepEqual(ledger, { organizationId: 'org-123', surface: 'eval_bench' })
  assert.ok(judgeLedgers.length > 0, 'the judge must have been called')
  for (const ledger of judgeLedgers) assert.deepEqual(ledger, { organizationId: 'org-123', surface: 'eval_bench' })
})

test('runBench omits the ledger entirely when no organizationId is given (the bare CLI path)', async () => {
  const runnerLedgers: (LedgerContext | undefined)[] = []
  const judgeLedgers: (LedgerContext | undefined)[] = []

  await runBench({
    models: ['claude-sonnet-5'],
    log: () => undefined,
    createRunner: () => makeSucceedingRunner({ text: 'ok', toolCalls: [], usage: usage(1, 1), provider: 'anthropic', servedModel: 'claude-sonnet-5', latencyMs: 1 }, runnerLedgers),
    judge: makeFakeJudge({ pass: true, score: 0.5, reasoning: 'meh' }, judgeLedgers),
    prisma: { modelEvalResult: { create: async () => undefined } },
  })

  assert.ok(runnerLedgers.length > 0)
  for (const ledger of runnerLedgers) assert.equal(ledger, undefined)
  assert.ok(judgeLedgers.length > 0)
  for (const ledger of judgeLedgers) assert.equal(ledger, undefined)
})

test('a successful bench row persists summed tokens, a nonzero costUsd, 3 samples, and the current harness version', async () => {
  const created: Record<string, unknown>[] = []
  await runBench({
    models: ['claude-sonnet-5'],
    log: () => undefined,
    createRunner: () => makeSucceedingRunner({ text: 'ok', toolCalls: [], usage: usage(1000, 200), provider: 'anthropic', servedModel: 'claude-sonnet-5', latencyMs: 1 }, []),
    judge: makeFakeJudge({ pass: true, score: 0.7, reasoning: 'solid' }, []),
    prisma: { modelEvalResult: { create: async (args) => created.push(args.data) } },
  })

  assert.ok(created.length > 0)
  for (const row of created) {
    assert.equal(row.harnessVersion, CURRENT_HARNESS_VERSION)
    assert.equal(row.inputTokens, 1000)
    assert.equal(row.outputTokens, 200)
    assert.ok(typeof row.costUsd === 'number' && row.costUsd > 0, `expected a priced costUsd, got ${row.costUsd}`)
    assert.equal((row.samples as unknown[]).length, 3)
  }
})

test('an error row still persists the tokens burned before the failure (not zeros)', async () => {
  const created: Record<string, unknown>[] = []
  // A fresh instance per fixture (bench calls createRunner() once per fixture),
  // each one succeeding its first turn (spending real tokens) before dying on
  // the second — the shape of "the loop found a tool call, then the endpoint died".
  function makeFlakyRunner(): ModelRunner {
    let calls = 0
    return {
      model: 'fake',
      start: (input: string) => [{ role: 'user', content: input }],
      appendUserMessage() {},
      appendToolResults() {},
      async next() {
        calls += 1
        if (calls === 1) {
          return { text: '', toolCalls: [{ id: 't1', name: 'lookup', input: {} }], usage: usage(500, 50), provider: 'anthropic', servedModel: 'claude-sonnet-5', latencyMs: 1 } as ModelTurn
        }
        throw Object.assign(new Error('endpoint died'), { status: 503 })
      },
    }
  }

  await runBench({
    models: ['claude-sonnet-5'],
    log: () => undefined,
    createRunner: () => makeFlakyRunner(),
    judge: makeFakeJudge({ pass: true, score: 1, reasoning: 'n/a' }, []),
    prisma: { modelEvalResult: { create: async (args) => created.push(args.data) } },
  })

  assert.ok(created.length > 0)
  for (const row of created) {
    assert.equal(row.score, null)
    assert.equal(row.harnessVersion, CURRENT_HARNESS_VERSION)
    // The 500 input / 50 output tokens from the first (successful) turn must
    // not be dropped just because the SECOND turn threw.
    assert.equal(row.inputTokens, 500)
    assert.equal(row.outputTokens, 50)
    assert.ok(typeof row.costUsd === 'number' && row.costUsd > 0, `expected nonzero costUsd on the error row, got ${row.costUsd}`)
  }
})
