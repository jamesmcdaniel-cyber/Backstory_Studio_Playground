/**
 * Offline eval harness — types.
 *
 * An eval fixture describes ONE agent scenario: the system prompt + user input,
 * the tools the agent may call, and how to check the run. Two ways to run a
 * fixture:
 *
 *  1. Scripted (deterministic, offline, no API keys): a `script` of authored
 *     model turns is replayed through a ScriptedRunner. This exercises the real
 *     agent LOOP (turn dispatch, tool execution, transcript building) so a
 *     refactor of the loop or the provider IR is caught by trajectory asserts.
 *
 *  2. Live (real model, gated on a provider key): the fixture's `rubric` is
 *     graded by an LLM judge against the trajectory the real model produced.
 *
 * Fixtures can be authored by hand or generated from a persisted run transcript
 * (see from-transcript.ts) — a real run becomes a regression fixture.
 */
import type { ToolDefinition, TokenUsage } from '@/lib/llm/model-runner'

/** One scripted model turn: optional narration + zero or more tool calls. */
export type ScriptedToolCall = {
  name: string
  input?: Record<string, unknown>
  /** The tool result to feed back when this call runs (scripted replay only). */
  result?: unknown
  isError?: boolean
}

export type ScriptedTurn = {
  text?: string
  toolCalls?: ScriptedToolCall[]
}

/** Deterministic checks applied to a trajectory regardless of run mode. */
export type TrajectoryExpectation = {
  /** Every tool name here must appear in the trajectory (order-independent). */
  toolsCalled?: string[]
  /** No tool named here may appear in the trajectory. */
  toolsNotCalled?: string[]
  /** The final text must contain each of these substrings (case-insensitive). */
  finalTextIncludes?: string[]
  /** When true, assert no tool call returned an error result. */
  noToolErrors?: boolean
  /** Upper bound on model turns taken before the run ended. */
  maxTurns?: number
}

export type EvalFixture = {
  name: string
  /** Model for live runs; ignored by the scripted runner. */
  model?: string
  system: string
  input: string
  /** Tools offered to the model. Required for live runs; optional for scripted. */
  tools?: ToolDefinition[]
  /** Authored model turns for deterministic scripted replay. */
  script?: ScriptedTurn[]
  /**
   * Canned tool responses for LIVE runs, keyed by tool name. A missing entry
   * yields a generic `{ ok: true }` so the model can still make progress.
   */
  toolResponses?: Record<string, unknown>
  /** Hard cap on turns (defaults to 16, matching the runtime default). */
  maxTurns?: number
  /** Deterministic checks (applied in both modes). */
  expect?: TrajectoryExpectation
  /** Natural-language grading rubric for the LLM judge (live runs). */
  rubric?: string
}

/** One executed turn of a run. */
export type TrajectoryTurn = {
  text: string
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[]
  results: { name: string; content: string; isError: boolean }[]
}

/** The full record of a run, the unit both asserts and the judge operate on. */
export type Trajectory = {
  finalText: string
  turns: TrajectoryTurn[]
  toolsCalled: string[]
  toolErrors: number
  usage: { inputTokens: number; outputTokens: number }
  /**
   * The same totals as `usage`, but keeping cache-write/cache-read tokens in
   * their own buckets instead of folding them into inputTokens. `usage` is the
   * display shape (unchanged for backward compat); `rawUsage` is what
   * `computeCostUsd` needs to price the run correctly.
   */
  rawUsage: TokenUsage
  /** True when the run ended by hitting maxTurns rather than a final answer. */
  hitMaxTurns: boolean
}

export type JudgeResult = {
  pass: boolean
  /** 0..1 quality score. */
  score: number
  reasoning: string
}
