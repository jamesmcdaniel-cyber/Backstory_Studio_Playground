import { test } from 'node:test'
import assert from 'node:assert/strict'
import { n8nToFlow, looksLikeN8nWorkflow, fromN8nExpression, resolveN8nImportUrl, unwrapN8nPayload } from '@/lib/flows/import/from-n8n'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph } from '@/lib/flows/validate'

const n8nNode = (
  name: string,
  type: string,
  parameters: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) => ({ id: `id-${name}`, name, type, typeVersion: 1, position: [100, 200] as [number, number], parameters, ...extra })

const chain = (...names: string[]) => {
  const connections: Record<string, { main: Array<Array<{ node: string; type: 'main'; index: number }>> }> = {}
  for (let i = 0; i < names.length - 1; i++) {
    connections[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] }
  }
  return connections
}

test('looksLikeN8nWorkflow distinguishes n8n exports from Backstory packages', () => {
  assert.equal(looksLikeN8nWorkflow({ nodes: [n8nNode('W', 'n8n-nodes-base.webhook')], connections: {} }), true)
  assert.equal(looksLikeN8nWorkflow({ format: 'backstory-flow@1', flow: { name: 'x', graph: {} } }), false)
  assert.equal(looksLikeN8nWorkflow({ nodes: [], connections: {} }), false)
  assert.equal(looksLikeN8nWorkflow(null), false)
})

test('n8n expressions translate back to flow tokens', () => {
  const names = new Map([['HTTP Request', 'id-HTTP Request']])
  assert.equal(fromN8nExpression('={{ $json.account }}', names), '{{trigger.input.account}}')
  assert.equal(fromN8nExpression('={{ $node["HTTP Request"].json.status }}', names), '{{step.id-HTTP Request.output.status}}')
  assert.equal(fromN8nExpression("={{ $('HTTP Request').item.json.status }}", names), '{{step.id-HTTP Request.output.status}}')
  assert.equal(fromN8nExpression('plain text', names), 'plain text')
})

test('a webhook → http → if workflow converts to a runnable graph with real branches', () => {
  const workflow = {
    name: 'Lead router',
    nodes: [
      n8nNode('Webhook', 'n8n-nodes-base.webhook', { httpMethod: 'POST', path: 'lead' }),
      n8nNode('Fetch', 'n8n-nodes-base.httpRequest', { method: 'GET', url: '={{ $json.url }}' }),
      n8nNode('Check', 'n8n-nodes-base.if', {
        conditions: {
          combinator: 'and',
          conditions: [{ leftValue: '={{ $node["Fetch"].json.status }}', rightValue: 'active', operator: { type: 'string', operation: 'equals' } }],
        },
      }),
      n8nNode('Set won', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'result', value: 'won', type: 'string' }] } }),
      n8nNode('Set lost', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'result', value: 'lost', type: 'string' }] } }),
    ],
    connections: {
      Webhook: { main: [[{ node: 'Fetch', type: 'main' as const, index: 0 }]] },
      Fetch: { main: [[{ node: 'Check', type: 'main' as const, index: 0 }]] },
      Check: {
        main: [
          [{ node: 'Set won', type: 'main' as const, index: 0 }],
          [{ node: 'Set lost', type: 'main' as const, index: 0 }],
        ],
      },
    },
  }
  const result = n8nToFlow(workflow)
  assert.equal(result.name, 'Lead router')
  const graph = flowGraphSchema.parse(result.graph)

  const trigger = graph.nodes.find((n) => n.type === 'trigger') as any
  assert.equal(trigger.data.trigger?.type, 'webhook')

  const http = graph.nodes.find((n) => n.type === 'http') as any
  assert.equal(http.data.method, 'GET')
  assert.equal(http.data.url, '{{trigger.input.url}}')

  const cond = graph.nodes.find((n) => n.type === 'condition') as any
  assert.deepEqual(cond.data.clauses, [{ left: '{{step.id-Fetch.output.status}}', op: 'eq', right: 'active' }])

  const transforms = graph.nodes.filter((n) => n.type === 'transform') as any[]
  assert.equal(transforms.length, 2)
  assert.deepEqual(transforms[0].data.fields, [{ name: 'result', value: 'won' }])

  const trueEdge = graph.edges.find((e) => e.source === cond.id && e.branch === 'true')
  const falseEdge = graph.edges.find((e) => e.source === cond.id && e.branch === 'false')
  assert.ok(trueEdge && falseEdge, 'IF outputs 0/1 map to true/false branches')

  // Immediately usable: the imported graph passes flow validation.
  const validation = validateFlowGraph(graph)
  assert.deepEqual(validation.errors ?? [], [])
})

test('code, wait, and merge nodes convert to their native equivalents', () => {
  const workflow = {
    name: 'Utility belt',
    nodes: [
      n8nNode('When clicking', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Code', 'n8n-nodes-base.code', { mode: 'runOnceForEachItem', jsCode: 'return item' }),
      n8nNode('Wait', 'n8n-nodes-base.wait', { resume: 'timeInterval', amount: 5, unit: 'minutes' }),
      n8nNode('Merge', 'n8n-nodes-base.merge', { mode: 'append' }),
    ],
    connections: chain('When clicking', 'Code', 'Wait', 'Merge'),
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const code = graph.nodes.find((n) => n.type === 'code') as any
  assert.equal(code.data.language, 'javascript')
  assert.equal(code.data.mode, 'each')
  assert.equal(code.data.code, 'return item')
  const wait = graph.nodes.find((n) => n.type === 'wait') as any
  assert.equal(wait.data.mode, 'duration')
  assert.equal(wait.data.amount, '5')
  assert.equal(wait.data.unit, 'minutes')
  const join = graph.nodes.find((n) => n.type === 'join') as any
  assert.equal(join.data.mode, 'append')
})

test('LLM nodes become native ai steps; unknown app nodes become notes with a warning', () => {
  const workflow = {
    name: 'AI + Slack',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Think', '@n8n/n8n-nodes-langchain.agent', { text: 'Summarize {{ $json.body }}' }),
      n8nNode('Notify', 'n8n-nodes-base.slack', { channel: '#deals', text: 'done' }),
    ],
    connections: chain('Start', 'Think', 'Notify'),
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const ai = graph.nodes.find((n) => n.type === 'ai') as any
  assert.equal(ai.data.aiOp, 'ask')
  assert.match(ai.data.instructions ?? '', /Summarize/)
  const note = graph.nodes.find((n) => n.type === 'note') as any
  assert.match(note.data.text, /slack/i)
  assert.ok(result.warnings.some((w) => /Notify/.test(w)), 'the unconverted step is named in the warnings')
})

test('looping connections (Loop Over Items) are dropped so the graph stays acyclic', () => {
  const workflow = {
    name: 'Batch',
    nodes: [
      n8nNode('Start', 'n8n-nodes-base.manualTrigger'),
      n8nNode('Loop', 'n8n-nodes-base.splitInBatches'),
      n8nNode('Work', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'x', value: '1' }] } }),
    ],
    connections: {
      Start: { main: [[{ node: 'Loop', type: 'main' as const, index: 0 }]] },
      Loop: { main: [[{ node: 'Work', type: 'main' as const, index: 0 }]] },
      // The n8n loop-back edge that would make our DAG cyclic:
      Work: { main: [[{ node: 'Loop', type: 'main' as const, index: 0 }]] },
    },
  }
  const result = n8nToFlow(workflow)
  const graph = flowGraphSchema.parse(result.graph)
  const ids = new Map(graph.nodes.map((n) => [n.id, n]))
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.source) && ids.has(edge.target))
  }
  // No cycle: Work → Loop dropped.
  assert.ok(!graph.edges.some((e) => e.source === 'id-Work' && e.target === 'id-Loop'))
  assert.ok(result.warnings.some((w) => /loop/i.test(w)))
})

test('n8n.io template page URLs resolve to the template API; other URLs pass through', () => {
  assert.equal(
    resolveN8nImportUrl('https://n8n.io/workflows/2211-sync-crm-to-sheets/'),
    'https://api.n8n.io/api/templates/workflows/2211',
  )
  assert.equal(resolveN8nImportUrl('https://n8n.io/workflows/93'), 'https://api.n8n.io/api/templates/workflows/93')
  assert.equal(resolveN8nImportUrl('https://example.com/my-flow.json'), 'https://example.com/my-flow.json')
})

test('template-API and wrapped payloads unwrap to the inner workflow', () => {
  const inner = { name: 'T', nodes: [n8nNode('W', 'n8n-nodes-base.webhook')], connections: {} }
  assert.deepEqual(unwrapN8nPayload({ workflow: inner }), inner)
  assert.deepEqual(unwrapN8nPayload({ workflow: { workflow: inner } }), inner)
  assert.deepEqual(unwrapN8nPayload(inner), inner)
  assert.deepEqual(unwrapN8nPayload({ some: 'thing' }), { some: 'thing' })
})

test('a workflow with no trigger gets a manual trigger wired to its roots', () => {
  const workflow = {
    name: 'Headless',
    nodes: [n8nNode('Only', 'n8n-nodes-base.set', { assignments: { assignments: [{ name: 'a', value: 'b' }] } })],
    connections: {},
  }
  const graph = flowGraphSchema.parse(n8nToFlow(workflow).graph)
  const trigger = graph.nodes.find((n) => n.type === 'trigger')
  assert.ok(trigger)
  assert.ok(graph.edges.some((e) => e.source === trigger!.id && e.target === 'id-Only'))
})
