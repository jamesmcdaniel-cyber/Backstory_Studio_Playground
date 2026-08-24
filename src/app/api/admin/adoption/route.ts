import { systemPrisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  acceptanceRate, automationRatio, buildSurvival, completeWeeksBack, depthBucket, weekKey,
} from '@/lib/adoption/rollup'

/**
 * Cross-workspace adoption report for internal ops.
 *
 * Reads the rollup tables rather than raw executions: /api/cron/retention
 * prunes AgentExecution at 90 days, so anything longer-horizon is only
 * answerable from the aggregates. Never exposed to customer org admins — this
 * reaches across every workspace, which is why it sits behind
 * platform.administer alongside the rest of /admin.
 *
 * systemPrisma: cross-org aggregate by design.
 */

/** How many weeks of survival to report per cohort. */
const MAX_OFFSET = 12

export const GET = withAuthenticatedApi(async (request) => {
  const requested = Number(request.nextUrl.searchParams.get('weeks'))
  const weeks = Math.min(104, Math.max(4, Number.isFinite(requested) && requested > 0 ? requested : 26))

  const window = completeWeeksBack(new Date(), weeks)
  const since = window[0]

  const rows = await systemPrisma.adoptionWeek.findMany({
    where: { weekStart: { gte: since } },
    orderBy: { weekStart: 'asc' },
  })

  // Platform totals per week, summed across workspaces.
  const byWeek = new Map<string, {
    weekStart: string; agentsCreated: number; agentsDeleted: number
    execTotal: number; execManual: number; execByTrigger: Record<string, number>
    engagedUsers: number; approvalsApproved: number; approvalsRejected: number; approvalsOther: number
  }>()
  for (const row of rows) {
    const key = weekKey(row.weekStart)
    const entry = byWeek.get(key) ?? {
      weekStart: key, agentsCreated: 0, agentsDeleted: 0, execTotal: 0, execManual: 0,
      execByTrigger: {}, engagedUsers: 0, approvalsApproved: 0, approvalsRejected: 0, approvalsOther: 0,
    }
    entry.agentsCreated += row.agentsCreated
    entry.agentsDeleted += row.agentsDeleted
    entry.execTotal += row.execTotal
    entry.execManual += row.execManual
    // engagedUsers sums DISTINCT-per-org counts. A human in two workspaces is
    // counted twice; that is deliberate — this measures adopting seats, not
    // unique humans, and the per-org distinctness is what the depth chart uses.
    entry.engagedUsers += row.engagedUsers
    entry.approvalsApproved += row.approvalsApproved
    entry.approvalsRejected += row.approvalsRejected
    entry.approvalsOther += row.approvalsOther
    for (const [type, n] of Object.entries((row.execByTrigger ?? {}) as Record<string, number>)) {
      entry.execByTrigger[type] = (entry.execByTrigger[type] ?? 0) + n
    }
    byWeek.set(key, entry)
  }

  // Cohort sizes come from agentsCreated, so agents that never ran once stay in
  // the denominator — the case the curve exists to catch.
  const cohortSizes = new Map<string, number>()
  for (const row of rows) {
    const key = weekKey(row.weekStart)
    cohortSizes.set(key, (cohortSizes.get(key) ?? 0) + row.agentsCreated)
  }

  const cohortRows = await systemPrisma.agentCohortWeek.findMany({
    where: { cohortWeek: { gte: since } },
    select: { agentTaskId: true, cohortWeek: true, activeWeek: true },
  })

  const survival = buildSurvival(
    cohortSizes,
    cohortRows.map((row) => ({
      agentTaskId: row.agentTaskId,
      cohortWeek: weekKey(row.cohortWeek),
      activeWeek: weekKey(row.activeWeek),
    })),
    MAX_OFFSET,
  )

  // Per-workspace view of the most recent complete week that has data.
  const latestKey = [...byWeek.keys()].sort().pop() ?? null
  const latestRows = latestKey ? rows.filter((row) => weekKey(row.weekStart) === latestKey) : []

  const organizations = await systemPrisma.organization.findMany({
    where: { id: { in: latestRows.map((row) => row.organizationId) } },
    select: { id: true, name: true },
  })
  const nameById = new Map(organizations.map((org) => [org.id, org.name]))

  const byOrg = latestRows
    .map((row) => ({
      organizationId: row.organizationId,
      name: nameById.get(row.organizationId) ?? 'unknown',
      execTotal: row.execTotal,
      automationRatio: automationRatio(row.execTotal, row.execManual),
      acceptanceRate: acceptanceRate(row.approvalsApproved, row.approvalsRejected),
      engagedUsers: row.engagedUsers,
      depthBucket: depthBucket(row.engagedUsers),
    }))
    .sort((a, b) => b.execTotal - a.execTotal)
    .slice(0, 50)

  const depthDistribution = ['0', '1', '2-4', '5-9', '10+'].map((bucket) => ({
    bucket,
    organizations: latestRows.filter((row) => depthBucket(row.engagedUsers) === bucket).length,
  }))

  return {
    success: true,
    latestWeek: latestKey,
    weeks: [...byWeek.values()]
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
      .map((entry) => ({
        ...entry,
        automationRatio: automationRatio(entry.execTotal, entry.execManual),
        acceptanceRate: acceptanceRate(entry.approvalsApproved, entry.approvalsRejected),
      })),
    survival,
    depthDistribution,
    byOrg,
  }
}, { permission: 'platform.administer', internalOnly: true })
