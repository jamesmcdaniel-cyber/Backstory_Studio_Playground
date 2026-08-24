import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Quarantined work must not dispatch. Both candidate queries in dispatch-tick
 * use systemPrisma, which bypasses the credential owner guard — so the filter
 * has to be written out explicitly there, and this pins that it is.
 */

/**
 * The full argument object of a `findMany` call, extracted by matching braces.
 *
 * An earlier version of this used a character-bounded regex, which silently
 * stopped matching the moment either `where` clause grew past one line — the
 * assertion still passed on an empty string for a while, which is the worst
 * outcome a guard test can have. Brace matching has no window to outgrow.
 */
function findManyArgs(source: string, call: string): string {
  const start = source.indexOf(call)
  assert.notEqual(start, -1, `${call} not found — the scan was renamed or removed`)
  let depth = 0
  for (let i = start + call.length - 1; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces after ${call}`)
}

test('both dispatch candidate scans filter out quarantined work', () => {
  // A static assertion, because the two queries are inline in the tick rather
  // than behind an exported function. The DB tests below prove the column
  // filters; this proves the scheduler actually asks for it. Without this,
  // deleting either filter breaks nothing that any test would notice.
  const source = readFileSync('src/lib/scheduling/dispatch-tick.ts', 'utf8')

  const agentScan = findManyArgs(source, 'systemPrisma.agentTask.findMany({')
  const flowScan = findManyArgs(source, 'systemPrisma.flow.findMany({')

  assert.match(agentScan, /quarantinedAt: null/, 'the agent scan must exclude quarantined tasks')
  assert.match(flowScan, /quarantinedAt: null/, 'the flow scan must exclude quarantined flows')

  // The due-range pre-filter must include un-stamped rows. Without the NULL
  // branch a freshly migrated or freshly edited row is invisible to the
  // scheduler — the silent-stop failure this column was added to prevent.
  for (const [label, scan] of [['agent', agentScan], ['flow', flowScan]] as const) {
    assert.match(scan, /nextRunAt: null/, `the ${label} scan must still read un-stamped rows`)
    assert.match(scan, /nextRunAt: \{ lte: now \}/, `the ${label} scan must read rows whose next run has arrived`)
  }
})

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seedTestOrg: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg } = await import('@/lib/server/__tests__/test-auth'))
  })

  test('a quarantined ACTIVE flow is not a dispatch candidate', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const flow = await prisma.flow.create({
        data: {
          organizationId: s.organizationId,
          userId: s.userId,
          name: 'quarantined',
          status: 'ACTIVE',
          publishedGraph: { nodes: [], edges: [] },
          trigger: { type: 'schedule', schedule: { kind: 'hourly' } },
          quarantinedAt: new Date(),
        },
      })

      const candidates = await prisma.flow.findMany({
        where: { organizationId: s.organizationId, status: 'ACTIVE', quarantinedAt: null },
        select: { id: true },
      })

      assert.equal(
        candidates.some((row: { id: string }) => row.id === flow.id),
        false,
        'quarantined flow must be excluded from dispatch candidates',
      )
    } finally {
      await s.cleanup()
    }
  })

  test('a quarantined ACTIVE agent task is not a dispatch candidate', async () => {
    const s = await seedTestOrg(prisma)
    try {
      const task = await prisma.agentTask.create({
        data: {
          organizationId: s.organizationId,
          userId: s.userId,
          description: 'quarantined',
          objective: 'none',
          status: 'ACTIVE',
          quarantinedAt: new Date(),
        },
      })

      const candidates = await prisma.agentTask.findMany({
        where: { organizationId: s.organizationId, status: 'ACTIVE', quarantinedAt: null },
        select: { id: true },
      })

      assert.equal(
        candidates.some((row: { id: string }) => row.id === task.id),
        false,
        'quarantined agent task must be excluded from dispatch candidates',
      )
    } finally {
      await s.cleanup()
    }
  })
}
