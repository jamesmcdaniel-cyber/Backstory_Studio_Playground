import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * DB-backed coverage for the activity indexer sweep (Task 8 of the
 * activity-event substrate plan): `ActivityEvent.indexedAt` is the sole
 * authority on "reached the graph" — this proves the sweep only stamps it
 * for rows that actually committed, leaves the rest untouched (idempotent
 * re-run, ragEnabled()-off never lies), and wires dispatched-claim → run
 * edges. Runs only against TEST_DATABASE_URL — CI-mode DB suite, not the
 * local gate.
 */

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let systemPrisma: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma, systemPrisma } = await import('@/lib/prisma'))
    // The sweep scans indexedAt IS NULL cross-org by design (a real cron
    // sweep, no org filter). Other DB test suites leave unindexed
    // ActivityEvent rows lying around in this shared local repro DB — clear
    // them first so this test's counts are deterministic. Legitimate
    // systemPrisma use: local-only test-isolation cleanup, not a request path.
    await systemPrisma.activityEvent.deleteMany({ where: { indexedAt: null } })

    const stamp = Date.now()
    const org = await prisma.organization.create({ data: { name: 'Indexer Sweep', slug: `indexer-sweep-${stamp}` } })
    ids.org = org.id

    const event = await prisma.activityEvent.create({
      data: {
        organizationId: ids.org,
        source: 'github',
        sourceEventId: `evt-${stamp}`,
        kind: 'pr.opened',
        occurredAt: new Date(),
        payload: { number: 1 },
        subject: { repo: 'org/repo', prNumber: 1 },
        visibility: 'org',
      },
    })
    ids.event = event.id

    const claim = await prisma.activityTriggerClaim.create({
      data: {
        organizationId: ids.org,
        activityEventId: event.id,
        flowId: crypto.randomUUID(),
        status: 'dispatched',
        flowRunId: crypto.randomUUID(),
      },
    })
    ids.flowRunId = claim.flowRunId
  })

  after(async () => {
    if (!ids.org) return
    await prisma.activityTriggerClaim.deleteMany({ where: { organizationId: ids.org } })
    await prisma.activityEvent.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  test('ragEnabled()=false leaves indexedAt untouched (the column never lies)', async () => {
    delete process.env.VOYAGE_API_KEY
    delete process.env.NEO4J_URI
    const { runIndexerSweep } = await import('../indexer-sweep')
    const result = await runIndexerSweep()
    assert.equal(result.skipped, true)
    assert.equal(result.indexed, 0)

    const row = await prisma.activityEvent.findFirst({ where: { id: ids.event, organizationId: ids.org } })
    assert.equal(row.indexedAt, null, 'indexedAt was never stamped while RAG is disabled')
  })

  test('a successful commit stamps indexedAt and wires dispatched-claim edges; re-running is a no-op', async () => {
    // embedTexts requires a key even when a fetchImpl is injected (only
    // network caching is skipped) — value is never sent anywhere real,
    // stubFetch intercepts it. The `store` option is what actually bypasses
    // ragEnabled()'s Neo4j requirement.
    process.env.VOYAGE_API_KEY = 'test-key'
    const { MemoryGraphStore } = await import('@/lib/rag/memory-store')
    const { runIndexerSweep } = await import('../indexer-sweep')
    const store = new MemoryGraphStore()
    const stubFetch = (async (_url: unknown, init: unknown) => {
      const body = JSON.parse(String((init as { body?: string })?.body))
      const input: string[] = body.input
      return new Response(
        JSON.stringify({ data: input.map((_t, index) => ({ index, embedding: [index + 1, 0] })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    }) as typeof fetch

    const first = await runIndexerSweep({ store, fetchImpl: stubFetch })
    assert.equal(first.skipped, false)
    assert.ok(first.scanned >= 1)
    assert.equal(first.indexed, first.scanned)

    const row = await prisma.activityEvent.findFirst({ where: { id: ids.event, organizationId: ids.org } })
    assert.ok(row.indexedAt, 'indexedAt was stamped after a successful commit')

    const edges: Array<{ from: string; to: string; rel: string }> = (store as any).edges
    assert.ok(
      edges.some((e) => e.from === `activity:${ids.event}` && e.to === `run:${ids.flowRunId}` && e.rel === 'activity_triggered_run'),
      'dispatched claim produced an activity_triggered_run edge to the flow run',
    )
    assert.ok(
      edges.some((e) => e.from === `run:${ids.flowRunId}` && e.to === `activity:${ids.event}` && e.rel === 'about_activity'),
      'and the mirrored about_activity edge from the run',
    )

    // Idempotent re-run: this event's indexedAt is already stamped, so it's
    // outside the next pass's `indexedAt IS NULL` selection — re-running
    // never re-commits or re-stamps it.
    await runIndexerSweep({ store, fetchImpl: stubFetch })
    const rowAfterSecondPass = await prisma.activityEvent.findFirst({ where: { id: ids.event, organizationId: ids.org } })
    assert.equal(rowAfterSecondPass.indexedAt.getTime(), row.indexedAt.getTime(), 'indexedAt is unchanged by the second pass')
  })
}
