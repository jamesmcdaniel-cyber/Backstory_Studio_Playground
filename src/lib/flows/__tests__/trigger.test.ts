import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { FlowGraph } from '../graph'
import {
  ACTIVITY_KINDS_CLIENT,
  ACTIVITY_KIND_LABELS,
  normalizeFlowTrigger,
  preserveWebhookSecretHash,
  triggerFromGraph,
  triggerInputFieldsFromTrigger,
} from '../trigger'
import { ACTIVITY_KINDS } from '@/lib/activity/normalize'

test('triggerFromGraph extracts the editable trigger from the trigger node', () => {
  const graph: FlowGraph = {
    nodes: [
      {
        id: 'trigger',
        type: 'trigger',
        data: { trigger: { type: 'schedule', schedule: { type: 'daily', time: '09:00' }, input: '{"team":"sales"}' } },
      },
    ],
    edges: [],
  }
  assert.deepEqual(triggerFromGraph(graph), {
    type: 'schedule',
    schedule: { type: 'daily', time: '09:00' },
    input: '{"team":"sales"}',
  })
})

test('triggerFromGraph falls back to the existing runtime trigger for legacy graphs', () => {
  const graph: FlowGraph = { nodes: [{ id: 'trigger', type: 'trigger', data: {} }], edges: [] }
  assert.deepEqual(triggerFromGraph(graph, { type: 'webhook', webhookSecretHash: 'hash' }), {
    type: 'webhook',
    webhookSecretHash: 'hash',
  })
})

test('triggerFromGraph normalizes missing or invalid trigger types to manual', () => {
  const graph: FlowGraph = {
    nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'mystery', foo: true } } }],
    edges: [],
  }
  assert.deepEqual(triggerFromGraph(graph), { type: 'manual', foo: true })
})

test('preserveWebhookSecretHash keeps the existing secret across trigger edits', () => {
  assert.deepEqual(
    preserveWebhookSecretHash({ type: 'manual' }, { type: 'webhook', webhookSecretHash: 'hash' }),
    { type: 'manual', webhookSecretHash: 'hash' },
  )
})

test('triggerInputFieldsFromTrigger normalizes fields, required flags, and defaults', () => {
  const fields = triggerInputFieldsFromTrigger({
    type: 'manual',
    inputFields: [
      { name: 'account', type: 'string', description: 'Customer', required: true, default: 'Acme' },
      { name: 'count', type: 'number' },
      { name: 'weird', type: 'nope', default: '' },
      'not-a-record',
    ],
  })
  assert.deepEqual(fields, [
    { name: 'account', type: 'string', description: 'Customer', required: true, default: 'Acme' },
    { name: 'count', type: 'number', description: undefined, required: false, default: undefined },
    { name: 'weird', type: 'any', description: undefined, required: false, default: undefined },
  ])
  assert.deepEqual(triggerInputFieldsFromTrigger(undefined), [])
  assert.deepEqual(triggerInputFieldsFromTrigger({ type: 'manual' }), [])
})

test('normalizeFlowTrigger round-trips an activity trigger config', () => {
  const activity = {
    type: 'activity',
    source: 'salesforce',
    kinds: ['opportunity.updated', 'opportunity.closed'],
    filters: { channelId: undefined, actorExternalId: 'user-1' },
  }
  assert.deepEqual(normalizeFlowTrigger(activity), activity)
})

test('normalizeFlowTrigger round-trips a slack trigger config', () => {
  const slack = { type: 'slack', channelId: 'C0123', threadOnly: true }
  assert.deepEqual(normalizeFlowTrigger(slack), slack)
})

test('the client-safe activity kind vocabulary stays in lockstep with normalize.ts', () => {
  // ACTIVITY_KINDS_CLIENT is a hand-kept literal copy of ACTIVITY_KINDS (see
  // its doc comment for why it isn't imported) — this pins the two lists so a
  // kind added to one and forgotten in the other fails loudly here instead of
  // rendering as a raw code in the builder.
  assert.deepEqual([...ACTIVITY_KINDS_CLIENT].sort(), [...ACTIVITY_KINDS].sort())
  for (const kind of ACTIVITY_KINDS) {
    assert.ok(ACTIVITY_KIND_LABELS[kind as keyof typeof ACTIVITY_KIND_LABELS], `missing a plain-English label for "${kind}"`)
  }
})
