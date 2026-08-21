import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode).
// FlowRun.degraded is computed ONCE at finalize, from the FULL persisted step
// set — not re-inferred per-client over a possibly-truncated runs-list
// summary. A succeeded run with any failed-or-warned step is degraded; a
// clean succeeded run, and any non-succeeded run, is not.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let runFlowExecution: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runFlowExecution } = await import('../execute-flow'))
    const org = await prisma.organization.create({ data: { name: 'DegradedRun', slug: `degraded-run-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: org.id } })
    ids.user = user.id
  })

  after(async () => {
    await prisma.flow.deleteMany({ where: { organizationId: ids.org } })
    await prisma.organization.delete({ where: { id: ids.org } })
  })

  const run = async (graph: unknown, input: unknown) => {
    const flow = await prisma.flow.create({
      data: { name: `degraded-${Date.now()}`, organizationId: ids.org, userId: ids.user, status: 'ACTIVE', graph, publishedGraph: graph },
    })
    const result = await runFlowExecution({ flowId: flow.id, organizationId: ids.org, userId: ids.user, input, usePublished: true })
    const persisted = await prisma.flowRun.findFirst({ where: { id: result.flowRunId, organizationId: ids.org } })
    return { result, persisted }
  }

  test('a succeeded run with one warned (skipped) step persists degraded: true', async () => {
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        {
          id: 'js',
          type: 'code',
          data: {
            language: 'javascript',
            mode: 'all',
            code: "if (input === 'B') throw new Error('bad B'); return `did:${input}`",
            input: '{{item}}',
            perItem: { over: '{{trigger.input.items}}', itemError: 'skip' },
          },
        },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'js' }],
    }
    const { result, persisted } = await run(graph, { items: ['A', 'B', 'C'] })
    assert.equal(result.status, 'succeeded')
    assert.equal(persisted.degraded, true)
  })

  test('a clean succeeded run (no failed or warned steps) persists degraded: false', async () => {
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'tf', type: 'transform', data: { fields: [{ name: 'greeting', value: 'hi {{trigger.input.name}}' }] } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'tf' }],
    }
    const { result, persisted } = await run(graph, { name: 'Ada' })
    assert.equal(result.status, 'succeeded')
    assert.equal(persisted.degraded, false)
  })

  test('a failed run persists degraded: false — it is a succeeded-with-issues marker, not a general problem flag', async () => {
    const graph = {
      nodes: [
        { id: 'trigger', type: 'trigger', data: {} },
        { id: 'js', type: 'code', data: { language: 'javascript', mode: 'all', code: "throw new Error('boom')" } },
      ],
      edges: [{ id: 'e1', source: 'trigger', target: 'js' }],
    }
    const { result, persisted } = await run(graph, '')
    assert.equal(result.status, 'failed')
    assert.equal(persisted.degraded, false)
  })

  test('the legacy backfill migration flips a pre-migration succeeded-with-warnings row to degraded: true', async () => {
    // Runs that finished before 20260821090000 added the `degraded` column
    // never had it computed and were backfilled to the column default,
    // `false` — the honesty gap the 20260821120000 migration exists to
    // close. Seed a row in exactly that pre-migration shape (succeeded,
    // degraded: false, one warned step) and run the migration's own SQL
    // directly, rather than re-deriving equivalent SQL that could drift from
    // what actually ships.
    const flow = await prisma.flow.create({
      data: { name: `degraded-backfill-${Date.now()}`, organizationId: ids.org, userId: ids.user, graph: { nodes: [], edges: [] } },
    })
    const legacyRun = await prisma.flowRun.create({
      data: {
        flowId: flow.id,
        organizationId: ids.org,
        userId: ids.user,
        status: 'succeeded',
        degraded: false,
        finishedAt: new Date(),
      },
    })
    await prisma.flowRunStep.create({
      data: {
        flowRunId: legacyRun.id,
        nodeId: 'js',
        status: 'succeeded',
        warnings: ['dropped 1 of 3 items (itemError: skip)'],
        startedAt: new Date(),
        finishedAt: new Date(),
      },
    })

    const migrationSql = fs.readFileSync(
      path.join(process.cwd(), 'prisma/migrations/20260821120000_backfill_legacy_degraded/migration.sql'),
      'utf8',
    )
    await prisma.$executeRawUnsafe(migrationSql)

    const reloaded = await prisma.flowRun.findFirst({ where: { id: legacyRun.id, organizationId: ids.org } })
    assert.equal(reloaded.degraded, true, 'the legacy row must be flipped to degraded: true')
  })
}
