import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSnapshot } from '../submissions'

test('a flow template snapshot carries the executable artifact and its notes', () => {
  const snapshot = buildSnapshot('flow_template', {
    id: 'ft1',
    name: 'Digest',
    description: 'A digest',
    category: 'Reporting',
    graph: { nodes: [], edges: [] },
    notes: { objective: 'o', inputs: [], steps: [], setup: [], customize: [] },
    bindings: [],
    configuration: { tags: ['a'], authorName: 'Rin' },
    organizationId: 'org-1',
    userId: 'user-1',
    createdAt: new Date(),
  })

  assert.equal(snapshot.name, 'Digest')
  assert.deepEqual(snapshot.graph, { nodes: [], edges: [] })
  assert.equal((snapshot.configuration as { authorName: string }).authorName, 'Rin')
})

test('a snapshot never carries tenancy or identity columns', () => {
  const snapshot = buildSnapshot('agent_template', {
    id: 'at1',
    name: 'Digest',
    type: 'Reporting',
    configuration: { instructions: 'do a thing' },
    organizationId: 'org-1',
    userId: 'user-1',
    visibility: 'org',
    catalogueStatus: 'none',
    createdAt: new Date(),
    updatedAt: new Date(),
  })

  for (const key of ['id', 'organizationId', 'userId', 'visibility', 'catalogueStatus', 'createdAt', 'updatedAt']) {
    assert.ok(!(key in snapshot), `${key} must not be snapshotted — it belongs to the author's row, not the entry`)
  }
})

test('a shared skill snapshot carries its instructions', () => {
  const snapshot = buildSnapshot('shared_skill', {
    id: 's1',
    name: 'Qualify',
    description: 'Qualify a lead',
    category: 'Community',
    instructions: 'Ask about budget.',
    tags: ['sales'],
    integrations: [],
    authorName: 'Rin',
    organizationId: 'org-1',
  })

  assert.equal(snapshot.instructions, 'Ask about budget.')
  assert.ok(!('organizationId' in snapshot))
})

test('an unknown kind is rejected rather than silently snapshotted', () => {
  assert.throws(() => buildSnapshot('mystery' as never, {}), /unknown catalogue kind/i)
})
