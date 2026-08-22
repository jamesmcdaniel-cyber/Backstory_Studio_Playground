import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Indexer is gated on embeddingsConfigured() (VOYAGE_API_KEY). Without a key it
// must be a clean no-op; the correlation logic itself is covered by the store +
// retrieve contract tests. Here we assert the gate and that a configured run
// does not throw (embedding network is stubbed via the store contract).
const ORIGINAL = { ...process.env }
beforeEach(() => {
  process.env = { ...ORIGINAL }
})

test('indexSignal is a no-op when VOYAGE_API_KEY is unset', async () => {
  delete process.env.VOYAGE_API_KEY
  const { indexSignal } = await import(`../indexer?t=${Date.now()}-${Math.random()}`)
  // Should resolve without touching any store/network.
  await assert.doesNotReject(
    indexSignal({
      id: 's1', organizationId: 'org1', type: 'deal.risk_detected',
      accountId: 'a1', opportunityId: 'o1', stakeholderId: null, payload: { risk: 'high' },
    }),
  )
})

test('indexExecution and indexAgent are no-ops without a key', async () => {
  delete process.env.VOYAGE_API_KEY
  const { indexExecution, indexAgent } = await import(`../indexer?t=${Date.now()}-${Math.random()}`)
  await assert.doesNotReject(indexExecution({
    id: 'r1', organizationId: 'org1', agentTaskId: 'ag1', signalId: 's1',
    input: { signal: { accountId: 'a1' } }, output: { text: 'done' }, status: 'completed',
  }))
  await assert.doesNotReject(indexAgent({
    id: 'ag1', organizationId: 'org1', title: 'Test', objective: 'do x', description: null,
  }))
})

test('removeRetiredFromGraph is a no-op when Neo4j is not configured', async () => {
  delete process.env.NEO4J_URI
  const { removeRetiredFromGraph } = await import(`../indexer?t=${Date.now()}-${Math.random()}`)
  // Should resolve without touching any store, even with a non-empty group.
  await assert.doesNotReject(
    removeRetiredFromGraph([
      { organizationId: 'org1', executionIds: ['r1', 'r2'], signalIds: ['s1'] },
    ]),
  )
})

// ── commitActivity — Task 8 (graph-RAG indexing + indexedAt sweeper) ────────

const stubFetch = (async (_url: unknown, init: unknown) => {
  const body = JSON.parse(String((init as { body?: string })?.body))
  const input: string[] = body.input
  return new Response(
    JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [index + 1, 0] })) }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}) as typeof fetch

test('commitActivity is a no-op (never stamps anything) when ragEnabled() is false', async () => {
  delete process.env.VOYAGE_API_KEY
  delete process.env.NEO4J_URI
  const { commitActivity } = await import(`../indexer?t=${Date.now()}-${Math.random()}`)
  const result = await commitActivity([
    { id: 'evt1', organizationId: 'org1', source: 'slack', kind: 'message.posted', subject: { channelId: 'C1' }, visibility: 'org', ownerUserId: null },
  ])
  assert.deepEqual(result.committedIds, [])
})

test('commitActivity upserts activity: nodes with correct visibility, entity edges, and dispatch edges', async () => {
  // embedTexts requires a key even when a fetchImpl is injected (only network
  // caching is skipped) — value is never sent anywhere real, stubFetch intercepts it.
  process.env.VOYAGE_API_KEY = 'test-key'
  const { MemoryGraphStore } = await import('../memory-store')
  const { commitActivity } = await import(`../indexer?t=${Date.now()}-${Math.random()}`)
  const store = new MemoryGraphStore()

  const result = await commitActivity(
    [
      {
        id: 'evt-org', organizationId: 'org1', source: 'salesforce', kind: 'record.updated',
        subject: { recordId: 'acct-1', sobject: 'Account' }, visibility: 'org', ownerUserId: null,
        dispatchedRunIds: ['run-1'],
      },
      {
        id: 'evt-private', organizationId: 'org1', source: 'slack', kind: 'message.posted',
        subject: { channelId: 'C1' }, visibility: 'private', ownerUserId: 'user-1',
      },
    ],
    { store, fetchImpl: stubFetch },
  )

  assert.deepEqual(result.committedIds.sort(), ['evt-org', 'evt-private'])

  const orgNode = (store as any).nodes.get('activity:evt-org')
  assert.ok(orgNode, 'org-visibility activity node was upserted')
  assert.equal(orgNode.visibility, 'shared')
  assert.equal(orgNode.ownerUserId, null)
  assert.ok(!orgNode.text.includes('recordId')) // no raw payload/JSON dump, plain-English label only
  assert.match(orgNode.text, /salesforce activity: record updated/)

  const privateNode = (store as any).nodes.get('activity:evt-private')
  assert.ok(privateNode, 'private-visibility activity node was upserted')
  assert.equal(privateNode.visibility, 'private')
  assert.equal(privateNode.ownerUserId, 'user-1')

  // Subject ref resolution: Account sobject + recordId → about_account edge + account node.
  const accountNode = (store as any).nodes.get('account:acct-1')
  assert.ok(accountNode, 'account node was created from the resolved subject ref')
  const edges: Array<{ from: string; to: string; rel: string }> = (store as any).edges
  assert.ok(edges.some((e) => e.from === 'activity:evt-org' && e.to === 'account:acct-1' && e.rel === 'about_account'))

  // Dispatched claim → run edges, both directions.
  assert.ok(edges.some((e) => e.from === 'activity:evt-org' && e.to === 'run:run-1' && e.rel === 'activity_triggered_run'))
  assert.ok(edges.some((e) => e.from === 'run:run-1' && e.to === 'activity:evt-org' && e.rel === 'about_activity'))
})
