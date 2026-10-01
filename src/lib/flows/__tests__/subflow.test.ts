import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SUBFLOW_MAX_DEPTH, subflowChildInput, subflowGuard } from '../subflow'
import { validateFlowGraph } from '../validate'
import { emptyGraph, flowNodeSchema } from '../graph'
import { insertNodeAfter } from '../mutate'

test('subflow inputs preserve objects, arrays, numbers, booleans and null', () => {
  const input = { value: 7, items: [1, 2], enabled: false, zero: 0, nullable: null }
  assert.deepEqual(subflowChildInput(undefined, input), input)
  assert.deepEqual(subflowChildInput({ ...input, blank: ' ', unset: undefined }, ''), input)
  assert.equal(subflowChildInput(undefined, null), null)
})

test('subflowGuard blocks blank, self, and too-deep dispatches', () => {
  assert.match(subflowGuard({ flowId: '  ', selfFlowId: 'f1', depth: 0 }) ?? '', /no flow selected/i)
  assert.match(subflowGuard({ flowId: 'f1', selfFlowId: 'f1', depth: 0 }) ?? '', /cannot run itself/i)
  assert.match(subflowGuard({ flowId: 'f2', selfFlowId: 'f1', depth: SUBFLOW_MAX_DEPTH }) ?? '', /nest/i)
  assert.equal(subflowGuard({ flowId: 'f2', selfFlowId: 'f1', depth: SUBFLOW_MAX_DEPTH - 1 }), null)
})

test('subflowChildInput prefers non-blank mapped fields, drops blanks, falls back to input', () => {
  assert.deepEqual(subflowChildInput({ account: 'Acme', region: '  ' }, 'fallback'), { account: 'Acme' })
  assert.equal(subflowChildInput({ account: '   ' }, 'fallback'), 'fallback')
  assert.equal(subflowChildInput(undefined, 'fallback'), 'fallback')
  assert.equal(subflowChildInput(undefined, undefined), '')
})

test('subflow node parses and validates: missing flow errors, self-reference errors with context', () => {
  const parsed = flowNodeSchema.safeParse({ id: 's1', type: 'subflow', data: { flowId: 'f2', inputs: { account: '{{trigger.input}}' } } })
  assert.ok(parsed.success)

  let graph = emptyGraph()
  graph = insertNodeAfter(graph, 'trigger', 'subflow').graph
  const subflowNode = graph.nodes.find((n) => n.type === 'subflow')!
  const empty = validateFlowGraph(graph)
  assert.ok(empty.errors.some((issue) => issue.code === 'SUBFLOW_NO_FLOW'))

  graph = { ...graph, nodes: graph.nodes.map((n) => (n.id === subflowNode.id && n.type === 'subflow' ? { ...n, data: { ...n.data, flowId: 'me' } } : n)) }
  const self = validateFlowGraph(graph, { flowId: 'me' })
  assert.ok(self.errors.some((issue) => issue.code === 'SUBFLOW_SELF'))
  const other = validateFlowGraph(graph, { flowId: 'someone-else' })
  assert.ok(!other.errors.some((issue) => issue.code === 'SUBFLOW_SELF'))
})
