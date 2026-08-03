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
import { billableTokens, type ModelRunner, type ToolCall, type ToolResult } from '@/lib/llm/model-runner'
import { ScriptedRunner } from './scripted-runner'
import type { EvalFixture, ScriptedTurn, Trajectory, TrajectoryExpectation } from './types'

const DEFAULT_MAX_TURNS = 16

/** Resolves a tool call to the string content fed back to the model. */
export type ToolDispatch = (
  call: ToolCall,
  turnIndex: number,
) => Promise<{ content: string; isError: boolean }> | { content: string; isError: boolean }

export async function runLoop(
  runner: ModelRunner,
  fixture: EvalFixture,
  dispatch: ToolDispatch,
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
    hitMaxTurns: false,
  }

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const result = await runner.next(transcript, fixture.system, tools)
    // Trajectory.usage keeps its two-field display shape; fold every input
    // bucket into inputTokens so the total still reads as it did before the split.
    trajectory.usage.inputTokens += billableTokens(result.usage) - result.usage.outputTokens
    trajectory.usage.outputTokens += result.usage.outputTokens

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
