import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryGraphStore } from '../memory-store'
import { logicalNodeId, scopedNodeId, type GraphNode } from '../store'

const node = (organizationId: string, text: string, embedding = [1, 0]): GraphNode => ({
  id: 'account:23923381072', organizationId, type: 'account', text, props: {}, embedding, ownerUserId: null, visibility: 'shared', updatedAt: new Date().toISOString(),
})

test('the same People.ai account in two workspaces is two nodes, each seen only by its own workspace', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([node('org-a', 'Gillette as org A sees it')])
  await store.upsertNodes([node('org-b', 'Gillette as org B sees it')])
  const a = await store.search('org-a', null, [1, 0], 5)
  const b = await store.search('org-b', null, [1, 0], 5)
  assert.deepEqual(a.map((hit) => hit.node.text), ['Gillette as org A sees it'])
  assert.deepEqual(b.map((hit) => hit.node.text), ['Gillette as org B sees it'])
  assert.equal(a[0].node.id, 'account:23923381072', 'callers keep using logical ids')
})

test('deleting in one workspace leaves the other workspace\'s node alone', async () => {
  const store = new MemoryGraphStore()
  await store.upsertNodes([node('org-a', 'A'), node('org-b', 'B')])
  await store.deleteNodes('org-a', ['account:23923381072'])
  assert.equal((await store.search('org-a', null, [1, 0], 5)).length, 0)
  assert.equal((await store.search('org-b', null, [1, 0], 5)).length, 1)
})

test('scoped ids round-trip and never double-prefix', () => {
  const scoped = scopedNodeId('4ec95b2d', 'insight:sig:1:acct')
  assert.equal(scoped, '4ec95b2d::insight:sig:1:acct')
  assert.equal(scopedNodeId('4ec95b2d', scoped), scoped)
  assert.equal(logicalNodeId(scoped), 'insight:sig:1:acct')
  assert.equal(logicalNodeId('run:legacy-unscoped'), 'run:legacy-unscoped')
})
