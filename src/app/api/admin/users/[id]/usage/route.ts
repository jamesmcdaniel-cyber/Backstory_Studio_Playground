import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'

/**
 * GET /api/admin/users/[id]/usage — the operator console's per-user drill-down.
 *
 * Deliberately its own lazy-fetched route rather than folded into the table
 * response: /api/admin/users renders up to PAGE_SIZE (200) rows, and this
 * breakdown is only ever needed for the ONE row an operator expands. Loading
 * it eagerly for every row would turn one cheap listing query into hundreds of
 * per-user aggregates nobody asked to see.
 *
 * Display-only, same as the table it drills into: no budget or enforcement
 * reads or writes here.
 */

/** Windows the drill-down offers — the same set the table's own filter uses. */
const WINDOWS = new Set([7, 30, 90])

type Rollup = {
  calls: number
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number
}

const emptyRollup = (): Rollup => ({ calls: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0 })

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2) ?? ''
  const requested = Number(request.nextUrl.searchParams.get('days'))
  const days = WINDOWS.has(requested) ? requested : 30
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Same demo-org exclusion every admin aggregate applies (see
  // /api/admin/users): a demo workspace's User rows are anonymised clones of a
  // real person, copied in full at snapshot time, not a platform user whose
  // spend an operator should be able to look up. `isNot` also matches a user
  // with no organization at all, so it never blocks a real orgless account.
  const target = await systemPrisma.user.findFirst({
    where: { id, organization: { isNot: { kind: 'demo' } } },
    select: { id: true, organizationId: true },
  })
  if (!target) throw new ApiError('User not found.', 404, 'NOT_FOUND')

  const [byModelRows, bySurfaceRows, earliest, orgUnattributed] = await Promise.all([
    systemPrisma.llmCall.groupBy({
      by: ['provider', 'model'],
      where: { userId: id, createdAt: { gte: since } },
      _count: true,
      _sum: { inputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, outputTokens: true, costUsd: true },
    }),
    systemPrisma.llmCall.groupBy({
      by: ['surface'],
      where: { userId: id, createdAt: { gte: since } },
      _count: true,
      _sum: { inputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, outputTokens: true, costUsd: true },
    }),
    // Earliest row ACTUALLY in the window — may be newer than `since` if the
    // 90-day retention prune already removed older rows. Never implies history
    // predating this date exists.
    systemPrisma.llmCall.findFirst({
      where: { userId: id, createdAt: { gte: since } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
    // Legacy rows written before the userId column existed (or system/scheduled
    // dispatch with no owner) carry userId = null and are invisible to a
    // per-user query by construction — this figure's totals can under-report.
    // Flagged here so the UI can foot-note it rather than presenting the
    // per-user number as though it were complete.
    target.organizationId
      ? systemPrisma.llmCall.findFirst({
          where: { organizationId: target.organizationId, userId: null, createdAt: { gte: since } },
          select: { id: true },
        })
      : Promise.resolve(null),
  ])

  const toRollup = (sum: { inputTokens: number | null; cacheWriteTokens: number | null; cacheReadTokens: number | null; outputTokens: number | null; costUsd: unknown }, count: number): Rollup => ({
    calls: count,
    inputTokens: sum.inputTokens ?? 0,
    cacheWriteTokens: sum.cacheWriteTokens ?? 0,
    cacheReadTokens: sum.cacheReadTokens ?? 0,
    outputTokens: sum.outputTokens ?? 0,
    costUsd: Number(sum.costUsd ?? 0),
  })

  const byModel = byModelRows
    .map((row: any) => ({ provider: row.provider, model: row.model, ...toRollup(row._sum, row._count) }))
    .sort((a: any, b: any) => b.costUsd - a.costUsd)

  const bySurface = bySurfaceRows
    .map((row: any) => ({ surface: row.surface, ...toRollup(row._sum, row._count) }))
    .sort((a: any, b: any) => b.costUsd - a.costUsd)

  const totals = byModel.reduce<Rollup>((acc, row) => ({
    calls: acc.calls + row.calls,
    inputTokens: acc.inputTokens + row.inputTokens,
    cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
    cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
    outputTokens: acc.outputTokens + row.outputTokens,
    costUsd: acc.costUsd + row.costUsd,
  }), emptyRollup())

  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.userId,
    action: 'platform.users.usage_viewed',
    resourceType: 'user',
    resourceId: id,
    detail: { days },
  })

  return {
    success: true,
    userId: id,
    days,
    since: since.toISOString(),
    dataSince: earliest?.createdAt.toISOString() ?? null,
    totals,
    byModel,
    bySurface,
    hasUnattributedOrgUsage: Boolean(orgUnattributed),
  }
}, { permission: 'platform.administer', internalOnly: true })
