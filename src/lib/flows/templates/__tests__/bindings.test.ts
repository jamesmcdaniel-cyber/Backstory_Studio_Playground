import test from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '@/lib/flows/graph'
import { applyBindings, buildSetupChecklist, resolveBindings, type BindingContext } from '@/lib/flows/templates/bindings'
import type { FlowTemplateBinding, FlowTemplateNotes } from '@/lib/flows/templates/types'

const context: BindingContext = {
  agents: [
    { id: 'agent_1', name: 'Renewal Brief Writer' },
    { id: 'agent_2', name: 'Account Risk Scorer' },
  ],
  connections: [
    { id: 'nango:slack', name: 'Slack', tools: [{ name: 'send_message' }, { name: 'list_channels' }] },
    { id: 'nango:salesforce', name: 'Salesforce', tools: [{ name: 'list_renewals' }] },
    { id: 'cmcp123', name: 'Acme Internal MCP', tools: [{ name: 'send_message' }] },
  ],
}

const binding = (overrides: Partial<FlowTemplateBinding>): FlowTemplateBinding => ({
  nodeId: 'n1',
  kind: 'connection',
  label: 'Pick something',
  match: {},
  ...overrides,
})

test('an agent binding matches on exact name, then on containment', () => {
  const exact = resolveBindings([binding({ kind: 'agent', match: { agentName: 'renewal brief writer' } })], context)
  assert.equal(exact[0].resolvedId, 'agent_1')

  const partial = resolveBindings([binding({ kind: 'agent', match: { agentName: 'Renewal Brief' } })], context)
  assert.equal(partial[0].resolvedId, 'agent_1')
})

test('an agent binding with no plausible match resolves to null', () => {
  const resolved = resolveBindings([binding({ kind: 'agent', match: { agentName: 'Invoice Reconciler' } })], context)
  assert.equal(resolved[0].resolvedId, null)
})

test('a provider hint matches with or without its plane prefix', () => {
  assert.equal(resolveBindings([binding({ match: { provider: 'nango:slack' } })], context)[0].resolvedId, 'nango:slack')
  assert.equal(resolveBindings([binding({ match: { provider: 'slack' } })], context)[0].resolvedId, 'nango:slack')
})

test('a tool hint narrows to a connection that actually exposes it', () => {
  // Salesforce is named in the hint but has no send_message — so the match must
  // not fall through to it just because the name lines up.
  const resolved = resolveBindings([binding({ match: { provider: 'salesforce', toolName: 'send_message' } })], context)
  assert.notEqual(resolved[0].resolvedId, 'nango:salesforce')
})

test('an empty provider hint never guesses a connection', () => {
  assert.equal(resolveBindings([binding({ match: {} })], context)[0].resolvedId, null)
})

const graph = (): FlowGraph => ({
  nodes: [
    { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
    { id: 'ask', type: 'agent', data: { agentId: '', label: 'Ask the scorer' } },
    { id: 'post', type: 'tool', data: { connectionId: '', toolName: 'send_message', label: 'Post it' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'ask' },
    { id: 'e1', source: 'ask', target: 'post' },
  ],
})

test('resolved bindings are written into their nodes', () => {
  const bindings: FlowTemplateBinding[] = [
    binding({ nodeId: 'ask', kind: 'agent', match: { agentName: 'Account Risk Scorer' } }),
    binding({ nodeId: 'post', kind: 'connection', match: { provider: 'slack', toolName: 'send_message' } }),
  ]
  const applied = applyBindings(graph(), resolveBindings(bindings, context))
  const agentNode = applied.nodes.find((node) => node.id === 'ask')
  const toolNode = applied.nodes.find((node) => node.id === 'post')
  assert.equal(agentNode?.type === 'agent' && agentNode.data.agentId, 'agent_2')
  assert.equal(toolNode?.type === 'tool' && toolNode.data.connectionId, 'nango:slack')
})

test('an unresolved binding leaves its slot empty rather than guessing', () => {
  const bindings = [binding({ nodeId: 'ask', kind: 'agent', match: { agentName: 'Nobody' } })]
  const applied = applyBindings(graph(), resolveBindings(bindings, context))
  const agentNode = applied.nodes.find((node) => node.id === 'ask')
  assert.equal(agentNode?.type === 'agent' && agentNode.data.agentId, '')
})

test('a polling trigger binding writes into the trigger config', () => {
  const pollGraph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'poll', toolName: 'list_channels' } } }],
    edges: [],
  }
  const bindings = [binding({ nodeId: 'trigger', match: { provider: 'slack' } })]
  const applied = applyBindings(pollGraph, resolveBindings(bindings, context))
  const trigger = applied.nodes[0]
  assert.equal(trigger.type === 'trigger' && (trigger.data.trigger as Record<string, unknown>).connectionId, 'nango:slack')
  assert.equal(trigger.type === 'trigger' && (trigger.data.trigger as Record<string, unknown>).toolName, 'list_channels')
})

const notes = (setup: FlowTemplateNotes['setup']): FlowTemplateNotes => ({
  objective: 'x',
  inputs: [],
  steps: [],
  setup,
  customize: [],
})

test('the setup checklist lists unresolved bindings and skips resolved ones', () => {
  const bindings = [
    binding({ nodeId: 'ask', kind: 'agent', label: 'Pick a scorer', match: { agentName: 'Account Risk Scorer' } }),
    binding({ nodeId: 'post', kind: 'connection', label: 'Pick a Slack workspace', match: { provider: 'nowhere' } }),
  ]
  const checklist = buildSetupChecklist(resolveBindings(bindings, context), notes([]), [])
  assert.deepEqual(checklist.map((item) => item.label), ['Pick a Slack workspace'])
  assert.equal(checklist[0].nodeId, 'post')
})

test('the checklist merges declared setup and missing integrations, deduped', () => {
  const checklist = buildSetupChecklist(
    [],
    notes([{ label: 'Connect Salesforce', kind: 'integration', ref: 'salesforce' }]),
    ['Salesforce', 'Snowflake'],
  )
  // "Connect Salesforce" arrives from both sources and must appear once.
  assert.deepEqual(checklist.map((item) => item.label), ['Connect Salesforce', 'Connect Snowflake'])
})
