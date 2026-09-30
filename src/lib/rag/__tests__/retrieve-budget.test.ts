import test from 'node:test'
import assert from 'node:assert/strict'
import { retrieveContext, RAG_BUDGET_MS } from '../retrieve'
import type { GraphRagStore } from '../store'

test('graph context never holds a caller past the budget', async () => {
  // A store that never answers — the unreachable-Neo4j case.
  const hanging = new Proxy({}, { get: () => () => new Promise(() => undefined) }) as unknown as GraphRagStore
  const started = Date.now()
  const context = await retrieveContext(hanging, { organizationId: 'org', query: 'win rate', embed: async () => [0.1, 0.2] })
  const elapsed = Date.now() - started
  assert.deepEqual(context, { hits: [], related: [] })
  assert.ok(elapsed >= RAG_BUDGET_MS - 50 && elapsed < RAG_BUDGET_MS + 1_000, `took ${elapsed} ms`)
})

test('a store that answers inside the budget is used as before', async () => {
  const node = { id: 'n1', type: 'fact', text: 'Engaged deals win more', organizationId: 'org' }
  const store = {
    search: async () => [{ node, score: 0.9 }],
    expand: async () => [],
  } as unknown as GraphRagStore
  const context = await retrieveContext(store, { organizationId: 'org', query: 'win rate', embed: async () => [0.1, 0.2], minScore: 0 })
  assert.equal(context.hits.length, 1)
})
