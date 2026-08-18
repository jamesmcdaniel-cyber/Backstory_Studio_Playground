import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planSubflowExtraction, replaceRangeWithSubflow, type SubflowExtractionPlan } from '../subflow-extract'
import { flowGraphSchema, type FlowGraph } from '../graph'

const graph = (): FlowGraph => ({
  nodes: [
    { id: 'trigger', type: 'trigger', data: {} },
    { id: 'a', type: 'data', data: { op: 'compose', input: '{{trigger.input}}' } },
    { id: 'b', type: 'ai', data: { aiOp: 'summarize', input: '{{step.a.output}}' } },
    { id: 'c', type: 'data', data: { op: 'split', input: '{{step.b.output}}' } },
    { id: 'd', type: 'data', data: { op: 'join', input: '{{step.c.output}}' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'a' },
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'b', target: 'c' },
    { id: 'e3', source: 'c', target: 'd' },
  ],
})

function planOrThrow(g: FlowGraph, start: string, end: string): SubflowExtractionPlan {
  const plan = planSubflowExtraction(g, start, end)
  assert.ok(!('error' in plan), 'error' in plan ? plan.error : '')
  return plan
}

test('extracting a mid-chain range rewrites the one outside ref and wires the parent', () => {
  const g = graph()
  const plan = planOrThrow(g, 'b', 'c')
  // b read {{step.a.output}} — a is outside, so the child reads trigger input.
  const childB = plan.childGraph.nodes.find((n) => n.id === 'b')!
  assert.equal((childB.data as { input: string }).input, '{{trigger.input}}')
  assert.equal(plan.childInput, '{{step.a.output}}')
  // Child graph is schema-valid and starts at its own trigger.
  assert.ok(flowGraphSchema.safeParse(plan.childGraph).success)
  assert.ok(plan.childGraph.edges.some((e) => e.source === 'trigger' && e.target === 'b'))

  const { graph: parent, nodeId } = replaceRangeWithSubflow(g, plan, 'child-1', 'Summarize & split')
  const sub = parent.nodes.find((n) => n.id === nodeId)!
  assert.equal(sub.type, 'subflow')
  assert.equal((sub.data as { flowId: string }).flowId, 'child-1')
  assert.equal((sub.data as { input: string }).input, '{{step.a.output}}')
  // a → sub → d, and b/c are gone.
  assert.ok(parent.edges.some((e) => e.source === 'a' && e.target === nodeId))
  assert.ok(parent.edges.some((e) => e.source === nodeId && e.target === 'd'))
  assert.ok(!parent.nodes.some((n) => n.id === 'b' || n.id === 'c'))
  assert.ok(flowGraphSchema.safeParse(parent).success)
})

test('a range reading only trigger input needs no rewrite and passes trigger input through', () => {
  const plan = planOrThrow(graph(), 'a', 'b')
  assert.equal(plan.childInput, '{{trigger.input}}')
  const childA = plan.childGraph.nodes.find((n) => n.id === 'a')!
  assert.equal((childA.data as { input: string }).input, '{{trigger.input}}')
})

test('two distinct outside references are refused with a plain-English error', () => {
  const g = graph()
  ;(g.nodes[3].data as { input: string }).input = '{{step.a.output}} and {{step.b.output}}'
  const plan = planSubflowExtraction(g, 'c', 'd')
  assert.ok('error' in plan && /more than one earlier step/i.test(plan.error))
})

test('container members and bad ranges are refused', () => {
  const g2 = graph()
  assert.ok('error' in planSubflowExtraction(g2, 'c', 'a'), 'end before start refused')
  assert.ok('error' in planSubflowExtraction(g2, 'trigger', 'a'), 'trigger refused')
  assert.ok('error' in planSubflowExtraction(g2, 'a', 'nope'), 'missing step refused')

  const g3: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'l', type: 'loop', data: { over: '{{trigger.input}}', body: ['lb'] } },
      { id: 'lb', type: 'ai', data: { aiOp: 'summarize', input: '{{item}}' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'l' }],
  }
  const inContainer = planSubflowExtraction(g3, 'lb', 'lb')
  assert.ok('error' in inContainer && /For each or Parallel/.test(inContainer.error))
})

test('a variable used only inside a straight run moves in without extra wiring', () => {
  const g = graph()
  ;(g.nodes[2] as { type: string }).type = 'variable'
  ;(g.nodes[2] as { data: unknown }).data = { op: 'initialize', name: 'total', varType: 'string', value: 'seed' }
  ;(g.nodes[3].data as { input: string }).input = '{{var.total}}'
  const plan = planOrThrow(g, 'b', 'c')
  assert.equal(plan.childInputs, undefined)
  assert.deepEqual(plan.outputVariables, [])
  assert.ok(flowGraphSchema.safeParse(plan.childGraph).success)
})

test('a loop in the range carries its body along, with in-body refs intact', () => {
  const g: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'a', type: 'data', data: { op: 'compose', input: '{{trigger.input}}' } },
      { id: 'l', type: 'loop', data: { over: '{{step.a.output}}', body: ['lb'] } },
      { id: 'lb', type: 'ai', data: { aiOp: 'summarize', input: '{{item}}' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'a' },
      { id: 'e1', source: 'a', target: 'l' },
    ],
  }
  const plan = planOrThrow(g, 'l', 'l')
  assert.ok(plan.rangeIds.includes('lb'), 'loop body rides along')
  const childLoop = plan.childGraph.nodes.find((n) => n.id === 'l')!
  assert.equal((childLoop.data as { over: string }).over, '{{trigger.input}}')
  const childBody = plan.childGraph.nodes.find((n) => n.id === 'lb')!
  assert.equal((childBody.data as { input: string }).input, '{{item}}')
})
