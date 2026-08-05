import { test } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunActionFn } from '../interpret'
import type { FlowGraph } from '@/lib/flows/graph'

// Raw-I/O capture: every control-flow node must EMIT the resolved input it
// acted on, so the persisted step row shows what the node actually evaluated
// — not the schema-default `{}` the run panel used to render.

const byNode = (steps: { nodeId: string }[], id: string) => steps.filter((s) => s.nodeId === id)

test('condition, filter, and switch emit the resolved operands they compared', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'cond', type: 'condition', data: { clauses: [{ left: '{{trigger.input.tier}}', op: 'eq', right: 'gold' }] } },
      { id: 'sw', type: 'switch', data: { cases: [{ id: 'c1', left: '{{trigger.input.tier}}', op: 'eq', right: 'gold' }] } },
      { id: 'fil', type: 'filter', data: { clauses: [{ left: '{{trigger.input.tier}}', op: 'neq', right: 'blocked' }] } },
      { id: 'done', type: 'transform', data: { fields: [{ name: 'ok', value: 'yes' }] } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'cond' },
      { id: 'e2', source: 'cond', target: 'sw', branch: 'true' },
      { id: 'e3', source: 'sw', target: 'fil', branch: 'c1' },
      { id: 'e4', source: 'fil', target: 'done' },
    ],
  }
  const result = await interpretFlow(graph, { tier: 'gold' }, { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'succeeded')

  const cond = byNode(result.steps, 'cond')[0] as any
  assert.deepEqual(cond.input, { clauses: [{ left: 'gold', op: 'eq', right: 'gold' }] })

  const sw = byNode(result.steps, 'sw')[0] as any
  assert.deepEqual(sw.input, { cases: [{ id: 'c1', left: 'gold', op: 'eq', right: 'gold' }] })

  const fil = byNode(result.steps, 'fil')[0] as any
  assert.deepEqual(fil.input, { clauses: [{ left: 'gold', op: 'neq', right: 'blocked' }] })
})

test('transform and join emit the incoming value; data emits its resolved input; variable emits its resolved value', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'tf', type: 'transform', data: { fields: [{ name: 'name', value: '{{trigger.input.name}}' }] } },
      { id: 'jn', type: 'join', data: {} },
      { id: 'dt', type: 'data', data: { op: 'flatten', input: '{{trigger.input.items}}' } },
      { id: 'vr', type: 'variable', data: { op: 'initialize', name: 'greeting', value: 'hi {{trigger.input.name}}', varType: 'string' } },
    ],
    edges: [
      { id: 'e1', source: 'trigger', target: 'tf' },
      { id: 'e2', source: 'tf', target: 'jn' },
      { id: 'e3', source: 'jn', target: 'dt' },
      { id: 'e4', source: 'dt', target: 'vr' },
    ],
  }
  const result = await interpretFlow(graph, { name: 'Ada', items: [[1], [2, 3]] }, { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'succeeded')

  const tf = byNode(result.steps, 'tf')[0] as any
  assert.deepEqual(tf.input, { name: 'Ada', items: [[1], [2, 3]] }, 'transform input = the incoming record it mapped')

  const jn = byNode(result.steps, 'jn')[0] as any
  assert.deepEqual(jn.input, { name: 'Ada' }, 'passthrough join input = the value it forwarded')

  const dt = byNode(result.steps, 'dt')[0] as any
  assert.deepEqual(dt.input, { op: 'flatten', input: [[1], [2, 3]] }, 'data input = the resolved operand, not the template')

  const vr = byNode(result.steps, 'vr')[0] as any
  assert.deepEqual(vr.input, { op: 'initialize', name: 'greeting', value: 'hi Ada' })
})

test('wait and humanReview emit what they paused on', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'hr', type: 'humanReview', data: { message: 'Approve {{trigger.input.thing}}?' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'hr' }],
  }
  const result = await interpretFlow(graph, { thing: 'the deal' }, { runAgent: async () => ({ output: '' }) })
  assert.equal(result.status, 'waiting')
  const hr = byNode(result.steps, 'hr')[0] as any
  assert.deepEqual(hr.input, { question: 'Approve the deal?' })

  const waitGraph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'w', type: 'wait', data: { mode: 'duration', amount: '5', unit: 'minutes' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'w' }],
  }
  const waited = await interpretFlow(waitGraph, '', { runAgent: async () => ({ output: '' }) })
  assert.equal(waited.status, 'waiting')
  const w = byNode(waited.steps, 'w')[0] as any
  assert.deepEqual(w.input, { mode: 'duration', amount: '5', unit: 'minutes' })
})

test('loop emits the items it iterated, and a FAILED loop still carries the partial per-item results', async () => {
  const graph: FlowGraph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'lp',
        type: 'loop',
        data: {
          over: '{{trigger.input.items}}',
          body: ['work'],
        },
      },
      { id: 'work', type: 'tool', data: { connectionId: 'c1', toolName: 'do', args: '{"item":"{{item}}"}' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'lp' }],
  }
  const runAction: RunActionFn = async (node) => {
    const item = (node.config.args as { item: string }).item
    if (item === 'bad') return { error: 'boom' }
    return { output: `did:${item}` }
  }
  const result = await interpretFlow(graph, { items: ['a', 'bad', 'c'] }, { runAgent: async () => ({ output: '' }), runAction })
  assert.equal(result.status, 'failed')

  const lp = byNode(result.steps, 'lp')[0] as any
  assert.deepEqual(lp.input, { items: ['a', 'bad', 'c'] }, 'the iterated list is recorded on the container row')
  assert.ok(Array.isArray(lp.output), 'a failed loop keeps its partial per-item results instead of dropping them')
  assert.deepEqual(lp.output[0], 'did:a')
  assert.deepEqual(lp.output[1], { error: 'boom' })
})
