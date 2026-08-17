import { test } from 'node:test'
import assert from 'node:assert/strict'
import { flowGraphSchema, emptyGraph, triggerInputFieldSchema, AI_OPS, MAX_GRAPH_NODES, MAX_GRAPH_EDGES } from '../graph'

test('emptyGraph has a single manual trigger node and no edges', () => {
  const g = emptyGraph()
  assert.equal(g.nodes.length, 1)
  assert.equal(g.nodes[0].type, 'trigger')
  assert.deepEqual(g.edges, [])
})

test('flowGraphSchema accepts a valid agent+condition graph', () => {
  const parsed = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { inputFields: [{ name: 'account', type: 'string', description: 'Customer name.' }] } } },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}' } },
      { id: 'n2', type: 'condition', data: { left: '{{step.n1.output}}', op: 'contains', right: 'yes' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  })
  assert.equal(parsed.nodes.length, 3)
  const trigger = parsed.nodes.find((node) => node.type === 'trigger')
  assert.deepEqual(trigger?.data.trigger.inputFields[0], { name: 'account', type: 'string', description: 'Customer name.' })
})

test('flowGraphSchema allows agent timeouts up to 30 minutes', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}', timeoutMs: 1_800_000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  assert.equal(flowGraphSchema.parse(graph).nodes[1].type, 'agent')
  assert.throws(() =>
    flowGraphSchema.parse({
      ...graph,
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'n1', type: 'agent', data: { agentId: 'a1', input: '{{trigger.input}}', timeoutMs: 1_800_001 } },
      ],
    }),
  )
})

test('flowGraphSchema rejects an unknown node type', () => {
  assert.throws(() => flowGraphSchema.parse({ nodes: [{ id: 'x', type: 'webhook', data: {} }], edges: [] }))
})

test('flowGraphSchema rejects a condition with a bad op', () => {
  // 'startsWith' used to be the example of an unknown op; it is a real operator
  // now, so this pins an op that genuinely is not in CONDITION_OPS.
  assert.throws(() =>
    flowGraphSchema.parse({
      nodes: [{ id: 'c', type: 'condition', data: { left: 'a', op: 'soundsLike', right: 'b' } }],
      edges: [],
    }),
  )
})

test('triggerInputFieldSchema accepts a required flag', () => {
  const parsed = triggerInputFieldSchema.parse({ name: 'account', type: 'string', required: true })
  assert.equal(parsed.required, true)
  assert.equal(triggerInputFieldSchema.parse({ name: 'note', type: 'string' }).required, undefined)
})

test('agent nodes accept responseFormat and humanAssistance', () => {
  const graph = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'n1',
        type: 'agent',
        data: {
          agentId: 'a1',
          responseFormat: 'structured',
          humanAssistance: false,
          outputFields: [{ name: 'score', type: 'number' }],
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  })
  const agent = graph.nodes[1]
  assert.equal(agent.type, 'agent')
  if (agent.type === 'agent') {
    assert.equal(agent.data.responseFormat, 'structured')
    assert.equal(agent.data.humanAssistance, false)
  }
})

test('ai node schema accepts every op', () => {
  for (const aiOp of AI_OPS) {
    const graph = flowGraphSchema.parse({
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'n1', type: 'ai', data: { aiOp, input: '{{trigger.input}}' } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
    })
    const ai = graph.nodes.find((node) => node.id === 'n1')
    assert.equal(ai?.type, 'ai')
    if (ai?.type === 'ai') assert.equal(ai.data.aiOp, aiOp)
  }
})

test('ai node schema rejects an unknown op', () => {
  assert.throws(() =>
    flowGraphSchema.parse({
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'n1', type: 'ai', data: { aiOp: 'translate', input: 'x' } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
    }),
  )
})

test('ai node schema round-trips the full op-specific field set', () => {
  const graph = flowGraphSchema.parse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      {
        id: 'n1',
        type: 'ai',
        data: {
          aiOp: 'extract',
          input: '{{trigger.input}}',
          instructions: 'Pull the named fields from the text.',
          model: 'smart',
          outputFields: [{ name: 'amount', type: 'number' }],
          categories: ['Urgent', 'Later'],
          scoreMin: 1,
          scoreMax: 10,
          onError: 'continue',
          retries: 2,
          timeoutMs: 30000,
        },
      },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  })
  const ai = graph.nodes[1]
  assert.equal(ai.type, 'ai')
  if (ai.type === 'ai') {
    assert.equal(ai.data.model, 'smart')
    assert.deepEqual(ai.data.outputFields, [{ name: 'amount', type: 'number' }])
    assert.deepEqual(ai.data.categories, ['Urgent', 'Later'])
    assert.equal(ai.data.scoreMin, 1)
    assert.equal(ai.data.scoreMax, 10)
    assert.equal(ai.data.onError, 'continue')
    assert.equal(ai.data.retries, 2)
  }
})

test('ai node schema allows timeouts up to 30 minutes but no further', () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'n1', type: 'ai', data: { aiOp: 'ask', timeoutMs: 1_800_000 } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1' }],
  }
  assert.equal(flowGraphSchema.parse(graph).nodes[1].type, 'ai')
  assert.throws(() =>
    flowGraphSchema.parse({
      ...graph,
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'n1', type: 'ai', data: { aiOp: 'ask', timeoutMs: 1_800_001 } },
      ],
    }),
  )
})

test('node schema accepts an optional canvas position and round-trips it', () => {
  const withPos = flowGraphSchema.safeParse({
    nodes: [
      { id: 'trigger', type: 'trigger', data: {}, position: { x: 10, y: 20 } },
      { id: 'a', type: 'agent', data: { agentId: 'x', input: 'y' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'a' }],
  })
  assert.equal(withPos.success, true)
  if (withPos.success) {
    const trigger = withPos.data.nodes.find((n) => n.id === 'trigger')!
    assert.deepEqual(trigger.position, { x: 10, y: 20 })
    // A node without a position stays valid and undefined (back-compat).
    assert.equal(withPos.data.nodes.find((n) => n.id === 'a')!.position, undefined)
    // Type narrowing still works through the intersection.
    const a = withPos.data.nodes.find((n) => n.id === 'a')!
    if (a.type === 'agent') assert.equal(a.data.agentId, 'x')
  }
})

test('flowGraphSchema caps node and edge counts (multi-MB payload guard)', () => {
  const node = (id: string) => ({ id, type: 'agent', data: { agentId: 'a1', input: 'x' } })
  const edge = (id: string) => ({ id, source: 'trigger', target: 'trigger' })

  // At the cap: accepted.
  assert.equal(
    flowGraphSchema.parse({
      nodes: Array.from({ length: MAX_GRAPH_NODES }, (_, i) => node(`n${i}`)),
      edges: [],
    }).nodes.length,
    MAX_GRAPH_NODES,
  )

  // One over the node cap: rejected.
  assert.throws(() =>
    flowGraphSchema.parse({
      nodes: Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) => node(`n${i}`)),
      edges: [],
    }),
  )

  // One over the edge cap: rejected.
  assert.throws(() =>
    flowGraphSchema.parse({
      nodes: [{ id: 'trigger', type: 'trigger', data: {} }],
      edges: Array.from({ length: MAX_GRAPH_EDGES + 1 }, (_, i) => edge(`e${i}`)),
    }),
  )
})
