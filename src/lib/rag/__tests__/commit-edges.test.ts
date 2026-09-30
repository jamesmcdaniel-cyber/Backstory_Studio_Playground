import test from 'node:test'
import assert from 'node:assert/strict'
import { commitGraph } from '../indexer'
import { MemoryGraphStore } from '../memory-store'

test('edges committed on their own are persisted — the backfill writes all nodes first, then all edges', async () => {
  const store = new MemoryGraphStore()
  // Nodes arrive already embedded in the store (as the backfill's earlier batches leave them).
  await store.upsertNodes([
    { id: 'run:1', organizationId: 'org', type: 'run', text: 'Agent run', props: {}, embedding: [1, 0], ownerUserId: null, visibility: 'shared', updatedAt: new Date().toISOString() },
    { id: 'agent:1', organizationId: 'org', type: 'agent', text: 'Agent', props: {}, embedding: [0, 1], ownerUserId: null, visibility: 'shared', updatedAt: new Date().toISOString() },
  ])
  await commitGraph('org', [], [{ organizationId: 'org', from: 'run:1', to: 'agent:1', rel: 'ran_agent' }], { store })
  const neighbours = await store.expand('org', null, ['run:1'], 1)
  assert.deepEqual(neighbours.map((node) => node.id), ['agent:1'])
})

test('nothing to commit is still a no-op', async () => {
  const store = new MemoryGraphStore()
  await commitGraph('org', [], [], { store })
  assert.deepEqual(await store.expand('org', null, ['run:1'], 1), [])
})
