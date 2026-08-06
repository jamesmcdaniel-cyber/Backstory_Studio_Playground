import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { flowToN8n, translateTokens } from '../to-n8n'

const graph: FlowGraph = {
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'webhook' } } },
    { id: 'h1', type: 'http', data: { method: 'GET', url: 'https://api.example.com/{{trigger.input.id}}', label: 'Fetch' } },
    { id: 'c1', type: 'condition', data: { match: 'all', clauses: [{ left: '{{step.h1.output.status}}', op: 'eq', right: 'ok' }] } },
    { id: 'a1', type: 'agent', data: { agentId: 'x', input: 'Summarize {{step.h1.output.body}}', label: 'Summarize' } },
    { id: 's1', type: 'stop', data: {} },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'h1' },
    { id: 'e1', source: 'h1', target: 'c1' },
    { id: 'e2', source: 'c1', target: 'a1', branch: 'true' },
    { id: 'e3', source: 'c1', target: 's1', branch: 'false' },
  ],
}

test('flowToN8n maps node types to real n8n nodes', () => {
  const wf = flowToN8n({ name: 'Test flow', graph })
  const byName = new Map(wf.nodes.map((n) => [n.name, n]))
  assert.equal(wf.name, 'Test flow')
  assert.equal(byName.get('Trigger')!.type, 'n8n-nodes-base.webhook')
  assert.equal(byName.get('Fetch')!.type, 'n8n-nodes-base.httpRequest')
  assert.equal(byName.get('Condition')!.type, 'n8n-nodes-base.if')
  // Agent has no n8n equivalent → No-Op placeholder with instructions.
  assert.equal(byName.get('Summarize')!.type, 'n8n-nodes-base.noOp')
  assert.ok(byName.get('Summarize')!.notes?.includes('AI Agent'))
})

test('flowToN8n translates our tokens into n8n expressions', () => {
  const wf = flowToN8n({ name: 'x', graph })
  const fetch = wf.nodes.find((n) => n.name === 'Fetch')!
  assert.equal(fetch.parameters.url, '=https://api.example.com/{{ $json.id }}')
})

test('translateTokens maps trigger + step references', () => {
  const names = new Map([['h1', 'Fetch']])
  assert.equal(translateTokens('{{trigger.input}}', names), '={{ $json }}')
  assert.equal(translateTokens('{{trigger.input.email}}', names), '={{ $json.email }}')
  assert.equal(translateTokens('{{step.h1.output.body}}', names), '={{ $node["Fetch"].json.body }}')
  assert.equal(translateTokens('no tokens', names), 'no tokens')
})

test('flowToN8n wires connections by name, condition true→output0 / false→output1', () => {
  const wf = flowToN8n({ name: 'x', graph })
  // trigger → Fetch → Condition
  assert.deepEqual(wf.connections['Trigger'].main[0][0], { node: 'Fetch', type: 'main', index: 0 })
  assert.deepEqual(wf.connections['Fetch'].main[0][0], { node: 'Condition', type: 'main', index: 0 })
  // condition: true edge on output 0 (Summarize), false edge on output 1 (Stop)
  assert.equal(wf.connections['Condition'].main[0][0].node, 'Summarize')
  assert.equal(wf.connections['Condition'].main[1][0].node, 'Stop')
})

test('flowToN8n gives every node a unique name and a position', () => {
  const wf = flowToN8n({ name: 'x', graph })
  const names = wf.nodes.map((n) => n.name)
  assert.equal(names.length, new Set(names).size, 'names are unique')
  for (const n of wf.nodes) {
    assert.equal(n.position.length, 2)
    assert.ok(Number.isFinite(n.position[0]) && Number.isFinite(n.position[1]))
  }
})

test('flowToN8n embeds export credentials into the webhook trigger note', () => {
  const credentials = { triggerUrl: 'https://app.example.com/api/flows/f1/trigger', triggerSecret: 's3cret-token' }
  const wf = flowToN8n({ name: 'x', graph, credentials })
  const trigger = wf.nodes.find((n) => n.name === 'Trigger')!
  assert.ok(trigger.notes?.includes(credentials.triggerUrl), 'note carries the trigger URL')
  assert.ok(trigger.notes?.includes(credentials.triggerSecret), 'note carries the minted secret')
  assert.ok(trigger.notes?.includes('x-trigger-secret'), 'note names the auth header')
})

test('flowToN8n without credentials keeps the plain webhook note (no secrets)', () => {
  const wf = flowToN8n({ name: 'x', graph })
  const trigger = wf.nodes.find((n) => n.name === 'Trigger')!
  assert.ok(!trigger.notes?.includes('x-trigger-secret'))
})

test('translateTokens maps the incoming-data reference to $json', () => {
  const names = new Map<string, string>()
  assert.equal(translateTokens('{{input}}', names), '={{ $json }}')
  assert.equal(translateTokens('{{input.query.opportunityId}}', names), '={{ $json.query.opportunityId }}')
})
