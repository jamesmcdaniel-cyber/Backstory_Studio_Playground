/**
 * Adoption rollup: reads a week of raw activity and writes one aggregate row
 * per organization, plus a cohort row per agent that ran.
 *
 * Recompute-and-upsert rather than incremental append. The job runs daily over
 * a two-week window, so it must be safe to run repeatedly over the same days —
 * and a missed day then self-heals on the next run instead of leaving a
 * permanent hole.
 *
 * systemPrisma throughout: this is a cross-org platform sweep by design, the
 * same justification as /api/cron/retention.
 */

import { systemPrisma } from '@/lib/prisma'
import { addWeeks, completeWeeksBack, weekKey } from '@/lib/adoption/rollup'

/** Prisma returns bigint from count(*) in raw SQL. */
const toInt = (value: unknown): number => Number(value ?? 0)

async function demoOrganizationIds(): Promise<string[]> {
  // Demo orgs are disposable anonymised clones (src/lib/demo/snapshot.ts).
  // Their history is canned data the clone wrote for itself, so counting it
  // would report imaginary adoption.
  const rows = await systemPrisma.organization.findMany({
    where: { kind: 'demo' },
    select: { id: true },
  })
  return rows.map((row) => row.id)
}

interface WeekTotals {
  agentsCreated: number
  agentsDeleted: number
  execTotal: number
  execManual: number
  execByTrigger: Record<string, number>
  engagedUsers: number
  approvalsApproved: number
  approvalsRejected: number
  approvalsOther: number
  approvalLatencyMedianMs: number | null
}

const emptyTotals = (): WeekTotals => ({
  agentsCreated: 0, agentsDeleted: 0, execTotal: 0, execManual: 0, execByTrigger: {},
  engagedUsers: 0, approvalsApproved: 0, approvalsRejected: 0, approvalsOther: 0,
  approvalLatencyMedianMs: null,
})

/**
 * Recompute one complete week and upsert its rows.
 *
 * `weekStart` must already be a Monday UTC — callers get it from
 * completeWeeksBack().
 */
export async function rollupWeek(weekStart: Date): Promise<{ organizations: number }> {
  const weekEnd = addWeeks(weekStart, 1)
  const weekStartKey = weekKey(weekStart)
  const demoIds = await demoOrganizationIds()
  const byOrg = new Map<string, WeekTotals>()
  const totals = (organizationId: string): WeekTotals => {
    const existing = byOrg.get(organizationId)
    if (existing) return existing
    const fresh = emptyTotals()
    byOrg.set(organizationId, fresh)
    return fresh
  }

  const [created, deleted] = await Promise.all([
    systemPrisma.agentTask.groupBy({
      by: ['organizationId'],
      where: { createdAt: { gte: weekStart, lt: weekEnd }, organizationId: { notIn: demoIds } },
      _count: { _all: true },
    }),
    systemPrisma.agentTask.groupBy({
      by: ['organizationId'],
      where: { deletedAt: { gte: weekStart, lt: weekEnd }, organizationId: { notIn: demoIds } },
      _count: { _all: true },
    }),
  ])
  for (const row of created) totals(row.organizationId).agentsCreated = row._count._all
  for (const row of deleted) totals(row.organizationId).agentsDeleted = row._count._all

  // Raw SQL: Prisma groupBy cannot group by a JSON path. `<> ALL('{}')` is
  // true for every row, so an empty demo list correctly excludes nothing.
  const triggerRows = await systemPrisma.$queryRaw<Array<{ organizationId: string; t: string | null; n: bigint }>>`
    SELECT e."organizationId", e.trigger->>'type' AS t, count(*) AS n
    FROM agent_executions e
    WHERE e."startedAt" >= ${weekStart} AND e."startedAt" < ${weekEnd}
      AND e."organizationId" <> ALL(${demoIds}::uuid[])
    GROUP BY 1, 2
  `
  for (const row of triggerRows) {
    const entry = totals(row.organizationId)
    const type = row.t ?? 'unknown'
    const n = toInt(row.n)
    entry.execByTrigger[type] = (entry.execByTrigger[type] ?? 0) + n
    entry.execTotal += n
    if (type === 'manual') entry.execManual += n
  }

  // Engaged humans: manual runs OR a chat message they wrote. Deliberately not
  // every execution — a scheduled run attributes to the agent's owner, which
  // would inflate one champion with fifty cron agents into a fifty-user team.
  // role = 'user' excludes the agent's own replies.
  const engagedRows = await systemPrisma.$queryRaw<Array<{ organizationId: string; n: bigint }>>`
    SELECT s."organizationId", count(DISTINCT s."userId") AS n
    FROM (
      SELECT e."organizationId", e."userId"
      FROM agent_executions e
      WHERE e."startedAt" >= ${weekStart} AND e."startedAt" < ${weekEnd}
        AND e.trigger->>'type' = 'manual'
      UNION
      SELECT m."organizationId", m."userId"
      FROM agent_chat_messages m
      WHERE m."createdAt" >= ${weekStart} AND m."createdAt" < ${weekEnd}
        AND m.role = 'user'
    ) s
    WHERE s."organizationId" <> ALL(${demoIds}::uuid[])
    GROUP BY 1
  `
  for (const row of engagedRows) totals(row.organizationId).engagedUsers = toInt(row.n)

  // Bucketed on createdAt, so a week's requests are counted in the week they
  // were ASKED. percentile_cont has no Prisma equivalent.
  const approvalRows = await systemPrisma.$queryRaw<Array<{
    organizationId: string; approved: bigint; rejected: bigint; other: bigint; median_ms: number | null
  }>>`
    SELECT a."organizationId",
      count(*) FILTER (WHERE a.status = 'approved') AS approved,
      count(*) FILTER (WHERE a.status = 'rejected') AS rejected,
      count(*) FILTER (WHERE a.status NOT IN ('approved', 'rejected')) AS other,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (a."decidedAt" - a."createdAt")) * 1000
      ) FILTER (WHERE a."decidedAt" IS NOT NULL) AS median_ms
    FROM approval_requests a
    WHERE a."createdAt" >= ${weekStart} AND a."createdAt" < ${weekEnd}
      AND a."organizationId" <> ALL(${demoIds}::uuid[])
    GROUP BY 1
  `
  for (const row of approvalRows) {
    const entry = totals(row.organizationId)
    entry.approvalsApproved = toInt(row.approved)
    entry.approvalsRejected = toInt(row.rejected)
    entry.approvalsOther = toInt(row.other)
    entry.approvalLatencyMedianMs = row.median_ms === null ? null : Math.round(Number(row.median_ms))
  }

  // Cohort rows for every agent that ran this week. ON CONFLICT DO NOTHING is
  // what makes the daily re-run free. date_trunc('week') is Monday-based and
  // the column is a naive timestamp holding UTC, so no timezone cast belongs
  // here — adding one would shift every cohort by hours.
  await systemPrisma.$executeRaw`
    INSERT INTO agent_cohort_weeks ("organizationId", "agentTaskId", "cohortWeek", "activeWeek")
    SELECT t."organizationId", t.id, date_trunc('week', t."createdAt")::date, ${weekStartKey}::date
    FROM agent_tasks t
    WHERE t."organizationId" <> ALL(${demoIds}::uuid[])
      AND EXISTS (
        SELECT 1 FROM agent_executions e
        WHERE e."agentTaskId" = t.id
          AND e."startedAt" >= ${weekStart} AND e."startedAt" < ${weekEnd}
      )
    ON CONFLICT ("agentTaskId", "activeWeek") DO NOTHING
  `

  for (const [organizationId, entry] of byOrg) {
    await systemPrisma.adoptionWeek.upsert({
      where: { organizationId_weekStart: { organizationId, weekStart } },
      create: { organizationId, weekStart, ...entry },
      update: { ...entry },
    })
  }

  return { organizations: byOrg.size }
}

/**
 * Recompute the last `weeks` COMPLETE weeks. Two on the daily schedule; more
 * when backfilling.
 */
export async function runAdoptionRollup(
  now: Date,
  weeks: number,
): Promise<{ weeks: string[]; organizations: number }> {
  const targets = completeWeeksBack(now, weeks)
  let organizations = 0
  for (const week of targets) {
    const result = await rollupWeek(week)
    organizations += result.organizations
  }
  return { weeks: targets.map(weekKey), organizations }
}
