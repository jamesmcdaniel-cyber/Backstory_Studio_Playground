import { systemPrisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

/**
 * Model-spend rollup for internal ops. Never exposed to customer org admins —
 * this reaches across every workspace, which is why it sits behind
 * catalogue.review alongside the rest of /admin.
 *
 * systemPrisma: cross-org aggregate by design.
 */
export const GET = withAuthenticatedApi(async (request) => {
  const days = Math.min(90, Math.max(1, Number(request.nextUrl.searchParams.get('days')) || 30))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // Demo orgs (kind === 'demo') are disposable anonymised clones of a real
  // workspace — see src/lib/demo/snapshot.ts. Their LlmCall rows are canned
  // history the clone wrote for itself, not real spend, and LlmCall carries
  // no Prisma relation to Organization (denormalized scalar FK only), so every
  // query below excludes them by id rather than through a relation filter.
  const demoOrgIds = (
    await systemPrisma.organization.findMany({ where: { kind: 'demo' }, select: { id: true } })
  ).map((org) => org.id)
  const notDemo = { organizationId: { notIn: demoOrgIds } }

  const [byOrg, bySurface, byModel, totalAgg] = await Promise.all([
    systemPrisma.llmCall.groupBy({
      by: ['organizationId'],
      where: { createdAt: { gte: since }, ...notDemo },
      _sum: { costUsd: true, inputTokens: true, cacheReadTokens: true, outputTokens: true },
      orderBy: { _sum: { costUsd: 'desc' } },
      take: 50,
    }),
    systemPrisma.llmCall.groupBy({
      by: ['surface'],
      where: { createdAt: { gte: since }, ...notDemo },
      _sum: { costUsd: true },
      _count: true,
    }),
    systemPrisma.llmCall.groupBy({
      by: ['provider', 'model', 'priceVersion'],
      where: { createdAt: { gte: since }, ...notDemo },
      _sum: { costUsd: true },
      _count: true,
      orderBy: { _sum: { costUsd: 'desc' } },
      take: 50,
    }),
    // Unbounded — byOrg above is capped at 50 workspaces for the table, but the
    // headline total must never be "the sum of whichever 50 happened to sort
    // highest". _min(createdAt) doubles as the honest floor of the window: on a
    // 90-day request against a table with a 90-day retention prune, the true
    // earliest row can be newer than `since`, and the page needs to say so.
    systemPrisma.llmCall.aggregate({
      where: { createdAt: { gte: since }, ...notDemo },
      _sum: { costUsd: true, inputTokens: true, cacheReadTokens: true, outputTokens: true },
      _count: { _all: true },
      _min: { createdAt: true },
    }),
  ])

  const organizations = await systemPrisma.organization.findMany({
    where: { id: { in: byOrg.map((row) => row.organizationId) } },
    select: { id: true, name: true },
  })
  const nameById = new Map(organizations.map((org) => [org.id, org.name]))

  return {
    success: true,
    days,
    // The true totals for the window, from an unbounded aggregate — never the
    // sum of the top-50 lists below, which drop everything past the 50th
    // workspace or model by spend.
    total: {
      costUsd: Number(totalAgg._sum.costUsd ?? 0),
      inputTokens: totalAgg._sum.inputTokens ?? 0,
      cacheReadTokens: totalAgg._sum.cacheReadTokens ?? 0,
      outputTokens: totalAgg._sum.outputTokens ?? 0,
      calls: totalAgg._count._all,
    },
    // Earliest row actually in the window — may be newer than `since` once the
    // 90-day retention prune has removed anything older, so the page can say
    // "data since {date}" instead of implying the full requested window exists.
    dataSince: totalAgg._min.createdAt,
    byOrg: byOrg.map((row) => ({
      organizationId: row.organizationId,
      name: nameById.get(row.organizationId) ?? 'unknown',
      costUsd: Number(row._sum.costUsd ?? 0),
      inputTokens: row._sum.inputTokens ?? 0,
      cacheReadTokens: row._sum.cacheReadTokens ?? 0,
      outputTokens: row._sum.outputTokens ?? 0,
    })),
    bySurface: bySurface.map((row) => ({
      surface: row.surface,
      costUsd: Number(row._sum.costUsd ?? 0),
      calls: row._count,
    })),
    byModel: byModel.map((row) => ({
      provider: row.provider,
      model: row.model,
      priceVersion: row.priceVersion,
      costUsd: Number(row._sum.costUsd ?? 0),
      calls: row._count,
    })),
  }
}, { permission: 'platform.administer', internalOnly: true })
