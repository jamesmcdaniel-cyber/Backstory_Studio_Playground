import test from 'node:test'
import assert from 'node:assert/strict'
import type { FlowTemplate } from '@prisma/client'
import { listFlowTemplateCatalogue, serializeFlowTemplate, serializeBuiltinFlowTemplate, sortStoredFlowTemplates, stepCountOf } from '@/lib/flows/templates/catalogue'
import { BUILTIN_FLOW_TEMPLATES } from '@/lib/flows/templates/builtin'

const row = (overrides: Partial<FlowTemplate> = {}): FlowTemplate =>
  ({
    id: 'ft_1',
    name: 'Nightly sync',
    description: 'Syncs things.',
    category: 'Data Operations',
    graph: {
      nodes: [
        { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
        { id: 'ask', type: 'ai', data: { aiOp: 'ask', input: 'hi', note: 'n' } },
        { id: 'sticky', type: 'note', data: { text: 'annotation' } },
      ],
      edges: [{ id: 'e0', source: 'trigger', target: 'ask' }],
    },
    trigger: { type: 'manual' },
    notes: { objective: 'o', inputs: [], steps: [], setup: [], customize: [] },
    bindings: [],
    configuration: { integrations: ['Slack'], tags: ['nightly'], icon: '🌙', exampleOutput: '', authorName: 'Ada' },
    isActive: true,
    source: 'user',
    visibility: 'org',
    userId: 'u1',
    organizationId: 'org_1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as FlowTemplate

test('step count excludes the trigger and canvas annotations', () => {
  assert.equal(serializeFlowTemplate(row()).stepCount, 1)
})

test('a serialized row exposes its catalogue metadata and ownership', () => {
  const serialized = serializeFlowTemplate(row(), 'org_1')
  assert.equal(serialized.icon, '🌙')
  assert.deepEqual(serialized.integrations, ['Slack'])
  assert.deepEqual(serialized.tags, ['nightly'])
  assert.equal(serialized.authorName, 'Ada')
  assert.equal(serialized.mine, true)
  assert.equal(serialized.custom, true)
})

test('another org viewing a community row cannot edit it', () => {
  assert.equal(serializeFlowTemplate(row({ visibility: 'global' }), 'org_2').mine, false)
})

test('a malformed stored blob degrades instead of throwing', () => {
  // A row written by an older version, or hand-edited — the gallery must still render.
  const broken = serializeFlowTemplate(row({ graph: { nodes: 'nope' }, notes: 42, bindings: 'no' } as never))
  assert.equal(broken.stepCount, 0)
  assert.equal(broken.notes.objective, '')
  assert.deepEqual(broken.bindings, [])
})

test('ranking puts the org\'s suggested templates first, then its own, then the community', () => {
  const old = new Date('2026-01-01')
  const recent = new Date('2026-07-01')
  const ranked = sortStoredFlowTemplates(
    [
      { organizationId: 'other', source: 'user', updatedAt: recent },
      { organizationId: 'mine', source: 'user', updatedAt: old },
      { organizationId: 'mine', source: 'ai_generated', updatedAt: old },
    ],
    'mine',
  )
  assert.deepEqual(
    ranked.map((entry) => `${entry.organizationId}:${entry.source}`),
    ['mine:ai_generated', 'mine:user', 'other:user'],
  )
})

test('ranking is newest-first within a group', () => {
  const ranked = sortStoredFlowTemplates(
    [
      { organizationId: 'mine', source: 'user', updatedAt: new Date('2026-01-01') },
      { organizationId: 'mine', source: 'user', updatedAt: new Date('2026-07-01') },
    ],
    'mine',
  )
  assert.equal(ranked[0].updatedAt.getFullYear(), 2026)
  assert.ok(ranked[0].updatedAt > ranked[1].updatedAt)
})

test('built-ins serialize as read-only catalogue entries', () => {
  for (const def of BUILTIN_FLOW_TEMPLATES) {
    const serialized = serializeBuiltinFlowTemplate(def)
    assert.equal(serialized.custom, false, `${def.id} should not be editable`)
    assert.equal(serialized.mine, false, `${def.id} should not be owned`)
    assert.equal(serialized.source, 'builtin')
    assert.equal(serialized.stepCount, stepCountOf(def.graph))
    assert.ok(serialized.stepCount > 0, `${def.id} has no steps`)
  }
})

/**
 * The built-ins are code, not data. Whatever the database is doing — table not
 * migrated on a fresh environment, no connection configured at all — every
 * workspace must still see them, or the Flows page and the gallery render an
 * empty catalogue with no explanation. Without a database configured this
 * exercises the degradation path directly.
 */
test('the catalogue serves the built-ins even when stored rows are unreadable', async () => {
  const consoleError = console.error
  console.error = () => {} // the degradation path logs by design; keep the run readable
  try {
    const catalogue = await listFlowTemplateCatalogue('00000000-0000-0000-0000-000000000000')
    for (const builtin of BUILTIN_FLOW_TEMPLATES) {
      assert.ok(catalogue.some((entry) => entry.id === builtin.id), `expected built-in "${builtin.id}" in the catalogue`)
    }
  } finally {
    console.error = consoleError
  }
})

test('a built-in trigger is derived from its graph, not stored separately', () => {
  const scheduled = BUILTIN_FLOW_TEMPLATES.find((entry) => entry.id === 'churn-risk-scorecard')!
  assert.equal((serializeBuiltinFlowTemplate(scheduled).trigger as { type: string }).type, 'schedule')
  const webhook = BUILTIN_FLOW_TEMPLATES.find((entry) => entry.id === 'webhook-triage')!
  assert.equal((serializeBuiltinFlowTemplate(webhook).trigger as { type: string }).type, 'webhook')
})
