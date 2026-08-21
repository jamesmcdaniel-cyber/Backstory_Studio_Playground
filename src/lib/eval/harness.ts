/**
 * The distilled agent loop the eval harness runs.
 *
 * This is a faithful, side-effect-free extraction of the turn loop in
 * execute-agent.ts: call the model, dispatch its tool calls, feed results back,
 * repeat until the model answers without calling a tool (or maxTurns). It omits
 * everything the runtime layers ON TOP (Prisma persistence, approvals, RAG,
 * budgets, notifications) so it can run offline in CI. Because it drives the
 * same ModelRunner interface, a fixture that passes here pins the loop's
 * behavior across refactors of the runner internals.
 */
import {
  billableTokens,
  emptyUsage,
  type LedgerContext,
  type ModelRunner,
  type ToolCall,
  type ToolResult,
} from '@/lib/llm/model-runner'
import { ScriptedRunner } from './scripted-runner'
import type { EvalFixture, ScriptedTurn, Trajectory, TrajectoryExpectation } from './types'

const DEFAULT_MAX_TURNS = 16

/**
 * Bump whenever fixture dispatch or judging semantics change (a live bench run
 * that was scored under different rules is not comparable to one scored under
 * these). `bench.ts` stamps this on every new `ModelEvalResult` row so the
 * admin console can exclude pre-fix rows from its rolling averages instead of
 * blending them in — see the inverted-score incident this closes.
 */
export const CURRENT_HARNESS_VERSION = '2026-08-20'

/** Resolves a tool call to the string content fed back to the model. */
export type ToolDispatch = (
  call: ToolCall,
  turnIndex: number,
) => Promise<{ content: string; isError: boolean }> | { content: string; isError: boolean }

/**
 * A trajectory that failed partway through, with whatever the loop had
 * accumulated before the throw attached. `runBench` reads `partialTrajectory`
 * off a caught error to persist the tokens/cost an errored candidate actually
 * burned, rather than the zeros an ordinary rethrow would leave behind.
 */
export class RunLoopError extends Error {
  readonly partialTrajectory: Trajectory
  constructor(cause: unknown, partialTrajectory: Trajectory) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'RunLoopError'
    this.cause = cause
    this.partialTrajectory = partialTrajectory
  }
}

export async function runLoop(
  runner: ModelRunner,
  fixture: EvalFixture,
  dispatch: ToolDispatch,
  ledger?: LedgerContext,
): Promise<Trajectory> {
  const maxTurns = fixture.maxTurns ?? DEFAULT_MAX_TURNS
  const tools = fixture.tools ?? []
  const transcript = runner.start(fixture.input)

  const trajectory: Trajectory = {
    finalText: '',
    turns: [],
    toolsCalled: [],
    toolErrors: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    rawUsage: emptyUsage(),
    hitMaxTurns: false,
  }

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const result = await runner.next(transcript, fixture.system, tools, ledger)
      // Trajectory.usage keeps its two-field display shape; fold every input
      // bucket into inputTokens so the total still reads as it did before the split.
      trajectory.usage.inputTokens += billableTokens(result.usage) - result.usage.outputTokens
      trajectory.usage.outputTokens += result.usage.outputTokens
      // rawUsage keeps the buckets separate — computeCostUsd needs cache
      // write/read tokens priced at their own rates, not folded into input.
      trajectory.rawUsage.inputTokens += result.usage.inputTokens
      trajectory.rawUsage.cacheWriteTokens += result.usage.cacheWriteTokens
      trajectory.rawUsage.cacheReadTokens += result.usage.cacheReadTokens
      trajectory.rawUsage.outputTokens += result.usage.outputTokens

      if (!result.toolCalls.length) {
        trajectory.finalText = result.text
        trajectory.turns.push({ text: result.text, toolCalls: [], results: [] })
        return trajectory
      }

      const results: ToolResult[] = []
      const recordedResults: Trajectory['turns'][number]['results'] = []
      for (const call of result.toolCalls) {
        trajectory.toolsCalled.push(call.name)
        const { content, isError } = await dispatch(call, turn)
        if (isError) trajectory.toolErrors += 1
        results.push({ toolCallId: call.id, content, isError })
        recordedResults.push({ name: call.name, content, isError })
      }
      runner.appendToolResults(transcript, results)
      trajectory.turns.push({ text: result.text, toolCalls: result.toolCalls, results: recordedResults })
    }
  } catch (error) {
    // Tokens already spent on turns that succeeded before this one failed are
    // real spend — attach what the loop had so the caller can still account
    // for it instead of losing it to an ordinary rethrow.
    throw new RunLoopError(error, trajectory)
  }

  trajectory.hitMaxTurns = true
  return trajectory
}

/**
 * Dispatch for scripted replay: return the result embedded in the matching
 * scripted tool call (falling back to `{ ok: true }`). Consumes matches
 * left-to-right so a tool called twice in one turn gets its two authored
 * results in order.
 */
export function scriptedDispatch(script: ScriptedTurn[]): ToolDispatch {
  const used = new Set<string>()
  return (call, turnIndex) => {
    const candidates = script[turnIndex]?.toolCalls?.filter((c) => c.name === call.name) ?? []
    const match = candidates.find((_, i) => !used.has(`${turnIndex}:${call.name}:${i}`))
    if (match) {
      const idx = candidates.indexOf(match)
      used.add(`${turnIndex}:${call.name}:${idx}`)
    }
    return {
      content: JSON.stringify(match?.result ?? { ok: true }),
      isError: Boolean(match?.isError),
    }
  }
}

/**
 * Dispatch for live runs: return the fixture's canned response for a tool by
 * name, or a generic success so the model can keep making progress.
 */
export function cannedDispatch(toolResponses: Record<string, unknown> = {}): ToolDispatch {
  return (call) => ({
    content: JSON.stringify(call.name in toolResponses ? toolResponses[call.name] : { ok: true }),
    isError: false,
  })
}

/**
 * Dispatch for LIVE runs: serve the tool results the fixture's SCRIPT already
 * authored, matched by tool name.
 *
 * This closes the gap that inverted the first production bench. Live runs used
 * cannedDispatch with the fixture's (absent) toolResponses, so every tool call
 * returned a bare {ok:true} — the account lookup carried no renewal data, and
 * the rubric then graded a message no model could honestly write. Careful
 * models flagged the missing data and asked for more information; the judge
 * scored them 0.1 while a model that barreled ahead scored 0.85. The bench was
 * measuring willingness to fabricate.
 *
 * Results are served per tool name in authored order (a tool called twice gets
 * its two scripted results), then stick on the LAST authored result for extra
 * calls — a re-lookup should see the same world, not a different one. Tools
 * the script never calls fall back to toolResponses, then to {ok: true}.
 */
export function fixtureDispatch(fixture: EvalFixture): ToolDispatch {
  const queues = new Map<string, unknown[]>()
  for (const turn of fixture.script ?? []) {
    for (const call of turn.toolCalls ?? []) {
      if (call.result === undefined) continue
      const queue = queues.get(call.name) ?? []
      queue.push(call.result)
      queues.set(call.name, queue)
    }
  }
  const fallback = cannedDispatch(fixture.toolResponses)
  return (call, turnIndex) => {
    const queue = queues.get(call.name)
    if (!queue?.length) return fallback(call, turnIndex)
    const result = queue.length > 1 ? queue.shift() : queue[0]
    return { content: JSON.stringify(result), isError: false }
  }
}

/** Run a fixture's scripted turns deterministically (offline, no API key). */
export async function replayScripted(fixture: EvalFixture): Promise<Trajectory> {
  if (!fixture.script) throw new Error(`fixture "${fixture.name}" has no script to replay`)
  const runner = new ScriptedRunner(fixture.script)
  return runLoop(runner, fixture, scriptedDispatch(fixture.script))
}

/** Deterministic checks. Returns the list of failures (empty = pass). */
export function checkTrajectory(trajectory: Trajectory, expect: TrajectoryExpectation | undefined): string[] {
  const failures: string[] = []
  if (!expect) return failures
  const called = new Set(trajectory.toolsCalled)
  for (const name of expect.toolsCalled ?? []) {
    if (!called.has(name)) failures.push(`expected tool "${name}" to be called (called: ${[...called].join(', ') || 'none'})`)
  }
  for (const name of expect.toolsNotCalled ?? []) {
    if (called.has(name)) failures.push(`expected tool "${name}" NOT to be called`)
  }
  const finalLower = trajectory.finalText.toLowerCase()
  for (const needle of expect.finalTextIncludes ?? []) {
    if (!finalLower.includes(needle.toLowerCase())) failures.push(`final text missing substring "${needle}"`)
  }
  if (expect.noToolErrors && trajectory.toolErrors > 0) {
    failures.push(`expected no tool errors, saw ${trajectory.toolErrors}`)
  }
  if (typeof expect.maxTurns === 'number' && trajectory.turns.length > expect.maxTurns) {
    failures.push(`took ${trajectory.turns.length} turns, expected <= ${expect.maxTurns}`)
  }
  return failures
}
