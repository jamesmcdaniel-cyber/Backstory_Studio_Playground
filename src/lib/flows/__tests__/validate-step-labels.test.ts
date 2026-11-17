/**
 * The validator agrees with the runtime about step references and error routes.
 * Its own file: validate.test.ts sits near the tsx+node22 load-hang cliff.
 *
 * - `{{step.<Label>…}}` resolves at run time (resolveContextPath falls back to
 *   step labels), so the checker must not call it a missing step.
 * - ai and subflow steps follow an error path at run time, so routing on
 *   error without one deserves the same nudge as tool/http/agent steps.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import { validateFlowGraph } from '../validate'
import { interpretFlow } from '@/features/flows/interpret'

const labelled: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'n1', type: 'agent', data: { agentId: 'agent-1', label: 'Previous Agent', input: 'hi' } },
    { id: 'n2', type: 'agent', data: { agentId: 'agent-1', label: 'v1.2 Pull', input: 'again' } },
    { id: 'n3', type: 'agent', data: { agentId: 'agent-1', input: 'Use {{step.Previous Agent.output}} and {{step.previous   agent.output}} and {{step.v1.2 Pull.output}}' } },
  ],
  edges: [
    { id: 'e1', source: 'trigger', target: 'n1' },
    { id: 'e2', source: 'n1', target: 'n2' },
    { id: 'e3', source: 'n2', target: 'n3' },
  ],
}

test('a token naming a step by its label is accepted — including labels with dots', () => {
  const result = validateFlowGraph(labelled, { agents: [{ id: 'agent-1' }] })
  assert.equal(result.issues.some((issue) => issue.code === 'TOKEN_UNKNOWN_STEP'), false)
})

test('the runtime resolves the same label tokens the validator now accepts', async () => {
  let seen = ''
  const result = await interpretFlow(labelled, '', {
    runAgent: async (node) => {
      if (node.id === 'n3') seen = node.input
      return { output: node.id === 'n1' ? 'first' : 'second' }
    },
  })
  assert.equal(result.status, 'succeeded')
  assert.equal(seen, 'Use first and first and second')
})

test('an agent title is a label too when the step has none of its own', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'agent-1', input: 'hi' } },
      { id: 'n2', type: 'agent', data: { agentId: 'agent-1', input: 'Use {{step.Account Researcher.output}}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }, { id: 'e2', source: 'n1', target: 'n2' }],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1', title: 'Account Researcher' }] })
  assert.equal(result.issues.some((issue) => issue.code === 'TOKEN_UNKNOWN_STEP'), false)
})

test('a token naming neither an id nor a label is still flagged', () => {
  const graph: FlowGraph = {
    ...labelled,
    nodes: [
      ...labelled.nodes.slice(0, 3),
      { id: 'n3', type: 'agent', data: { agentId: 'agent-1', input: 'Use {{step.Ghost Step.output}}' } },
    ],
  }
  const result = validateFlowGraph(graph, { agents: [{ id: 'agent-1' }] })
  assert.ok(result.errors.some((issue) => issue.code === 'TOKEN_UNKNOWN_STEP' && issue.nodeId === 'n3'))
})

test('ai and subflow steps that route on error without an error path are nudged', () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'classify', type: 'ai', data: { aiOp: 'summarize', input: 'x', onError: 'route' } },
      { id: 'child', type: 'subflow', data: { flowId: 'f-1', onError: 'route' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'classify' }, { id: 'e2', source: 'classify', target: 'child' }],
  } as FlowGraph
  const result = validateFlowGraph(graph)
  const flagged = result.warnings.filter((issue) => issue.code === 'ROUTE_NO_ERROR_PATH').map((issue) => issue.nodeId).sort()
  assert.deepEqual(flagged, ['child', 'classify'])
})
