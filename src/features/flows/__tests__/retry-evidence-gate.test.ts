import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunAgentFn } from '../interpret'
import { retryWarnings } from '../execute-flow'
import type { FlowGraph } from '@/lib/flows/graph'

// ---------------------------------------------------------------------------
// Task 4 review fixes:
//
// Finding 1 — a retried agent step that eventually PAUSES for human input
// (rather than succeeding or exhausting its budget) dropped its attempt-error
// trail entirely: `onStep` (execute-flow.ts) had no persistence branch for
// `waiting` rows, so the interpreter's warnings never reached the row.
//
// Finding 2 — with `retries: 0`, a single failed attempt still produced a
// one-entry `attemptErrors` ("attempt 1/1 failed: ..."), which the engine
// persisted as a "warning" duplicating the `error` field verbatim. Retry
// evidence is only evidence when a retry actually happened, so persistence is
// now gated on `attempts > 1`, not on `attemptErrors.length`.
//
// New tests live in this small standalone file rather than growing
// interpret.test.ts (already ~140KB, past the tsx hang-risk size noted in
// review).
// ---------------------------------------------------------------------------

test('retryWarnings: a single-attempt failure (retries:0) yields no warnings — it would just duplicate `error`', () => {
  assert.deepEqual(retryWarnings(1, ['attempt 1/1 failed: boom']), [])
})

test('retryWarnings: a genuine retry (more than one attempt) passes its evidence through', () => {
  assert.deepEqual(
    retryWarnings(2, ['attempt 1/2 failed: boom 1']),
    ['attempt 1/2 failed: boom 1'],
  )
  assert.deepEqual(
    retryWarnings(3, ['attempt 1/3 failed: boom 1', 'attempt 2/3 failed: boom 2']),
    ['attempt 1/3 failed: boom 1', 'attempt 2/3 failed: boom 2'],
  )
})

test('retryWarnings: zero failed attempts (first-try success) yields no warnings', () => {
  assert.deepEqual(retryWarnings(1, []), [])
})

// Finding 2, at the interpreter/agent seam: retries:0 must not manufacture a
// redundant warning even though runAgentWithReliability's aggregate still
// reports attempts:1 / one attemptErrors entry internally.
test('an agent step with retries:0 that fails carries no attempt-error warning — only the run/step `error` names it', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x', retries: 0, timeoutMs: 30000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  let calls = 0
  const runAgent: RunAgentFn = async () => {
    calls += 1
    return { error: 'boom' }
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'failed')
  assert.equal(calls, 1, 'retries:0 means exactly one attempt')
  const step = result.steps.find((s) => s.nodeId === 'n1')
  assert.equal(step?.error, 'boom')
  assert.equal(step?.warnings, undefined, 'a single failed attempt is not "retry evidence"')
})

// Finding 1: a step that fails once or twice, then the agent asks for human
// input, must still carry its attempt-error trail — the pause is otherwise
// indistinguishable from one that paused on the very first try.
test('a retried agent step that ends up waiting for human input still carries its attempt-error warnings', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x', retries: 2, timeoutMs: 30000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  let calls = 0
  const runAgent: RunAgentFn = async () => {
    calls += 1
    if (calls < 3) return { error: `boom ${calls}` }
    return { waiting: { status: 'waiting_user', question: 'Which region?' } }
  }
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'waiting')
  assert.equal(calls, 3)
  const step = result.steps.find((s) => s.nodeId === 'n1')
  assert.equal(step?.status, 'waiting')
  assert.deepEqual(step?.warnings, [
    'attempt 1/3 failed: boom 1',
    'attempt 2/3 failed: boom 2',
  ])
})

// A waiting pause with NO prior failed attempts must still add no noise.
test('an agent step that pauses on its first attempt gets no attempt-error warnings', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: 'x', retries: 2, timeoutMs: 30000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  const runAgent: RunAgentFn = async () => ({ waiting: { status: 'waiting_user', question: 'Which region?' } })
  const result = await interpretFlow(graph, '', { runAgent })
  assert.equal(result.status, 'waiting')
  const step = result.steps.find((s) => s.nodeId === 'n1')
  assert.equal(step?.warnings, undefined)
})
