import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runLoop, CURRENT_HARNESS_VERSION, RunLoopError } from '../harness'
import type { LedgerContext, ModelRunner, ModelTurn, ToolResult } from '@/lib/llm/model-runner'
import type { EvalFixture } from '../types'

/**
 * runLoop is the seam bench threads a ledger context through (model-runner's
 * `next(transcript, system, tools, ledger)`), and the seam it must recover
 * partial spend from when a candidate errors mid-run. Both are pinned here
 * against a fake ModelRunner rather than a real provider.
 */

function fixture(overrides: Partial<EvalFixture> = {}): EvalFixture {
  return { name: 'x', system: 's', input: 'go', ...overrides }
}

/** A runner whose `next` records every ledger context it was called with. */
class RecordingRunner implements ModelRunner {
  readonly model = 'recording'
  ledgersSeen: (LedgerContext | undefined)[] = []
  private turnIndex = 0
  constructor(private readonly turns: ModelTurn[]) {}
  start(input: string): unknown[] {
    return [{ role: 'user', content: input }]
  }
  appendUserMessage(transcript: unknown[], content: string) {
    transcript.push({ role: 'user', content })
  }
  appendToolResults(transcript: unknown[], results: ToolResult[]) {
    transcript.push({ role: 'user', content: results })
  }
  async next(_transcript: unknown[], _system: string, _tools: unknown[], ledger?: LedgerContext): Promise<ModelTurn> {
    this.ledgersSeen.push(ledger)
    const turn = this.turns[this.turnIndex]
    this.turnIndex += 1
    if (!turn) throw new Error('RecordingRunner ran out of scripted turns')
    return turn
  }
}

function usage(inputTokens: number, outputTokens: number, cacheWriteTokens = 0, cacheReadTokens = 0) {
  return { inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens }
}

test('CURRENT_HARNESS_VERSION is the exact stamp bench and the admin API compare against', () => {
  assert.equal(CURRENT_HARNESS_VERSION, '2026-08-20')
})

test('runLoop forwards the ledger context to every runner.next() call', async () => {
  const ledger: LedgerContext = { organizationId: 'org-1', surface: 'eval_bench' }
  const runner = new RecordingRunner([
    { text: '', toolCalls: [{ id: 't1', name: 'lookup', input: {} }], usage: usage(10, 5), provider: 'anthropic', servedModel: 'claude-sonnet-5', latencyMs: 5 },
    { text: 'done', toolCalls: [], usage: usage(20, 8), provider: 'anthropic', servedModel: 'claude-sonnet-5', latencyMs: 5 },
  ])
  await runLoop(runner, fixture(), () => ({ content: '{}', isError: false }), ledger)
  assert.equal(runner.ledgersSeen.length, 2)
  for (const seen of runner.ledgersSeen) assert.deepEqual(seen, ledger)
})

test('runLoop leaves the ledger undefined when the caller passes none (nightly\'s path)', async () => {
  const runner = new RecordingRunner([
    { text: 'done', toolCalls: [], usage: usage(1, 1), provider: 'anthropic', servedModel: 'claude-sonnet-5', latencyMs: 1 },
  ])
  await runLoop(runner, fixture(), () => ({ content: '{}', isError: false }))
  assert.deepEqual(runner.ledgersSeen, [undefined])
})

test('rawUsage accumulates all four token buckets across turns, unfolded', async () => {
  const runner = new RecordingRunner([
    { text: '', toolCalls: [{ id: 't1', name: 'lookup', input: {} }], usage: usage(10, 5, 2, 3), provider: 'anthropic', servedModel: 'claude-sonnet-5', latencyMs: 5 },
    { text: 'done', toolCalls: [], usage: usage(20, 8, 0, 1), provider: 'anthropic', servedModel: 'claude-sonnet-5', latencyMs: 5 },
  ])
  const trajectory = await runLoop(runner, fixture(), () => ({ content: '{}', isError: false }))
  assert.deepEqual(trajectory.rawUsage, { inputTokens: 30, cacheWriteTokens: 2, cacheReadTokens: 4, outputTokens: 13 })
  // The display shape is unchanged: cache buckets still fold into inputTokens.
  assert.deepEqual(trajectory.usage, { inputTokens: 36, outputTokens: 13 })
})

test('a runner that throws mid-loop surfaces the tokens already spent via RunLoopError.partialTrajectory', async () => {
  const runner = new RecordingRunner([
    { text: '', toolCalls: [{ id: 't1', name: 'lookup', input: {} }], usage: usage(100, 20), provider: 'anthropic', servedModel: 'claude-sonnet-5', latencyMs: 5 },
    // second call throws instead of returning a turn (no scripted turn queued)
  ])
  await assert.rejects(
    runLoop(runner, fixture(), () => ({ content: '{}', isError: false })),
    (error: unknown) => {
      assert.ok(error instanceof RunLoopError)
      assert.equal(error.partialTrajectory.rawUsage.inputTokens, 100)
      assert.equal(error.partialTrajectory.rawUsage.outputTokens, 20)
      return true
    },
  )
})
