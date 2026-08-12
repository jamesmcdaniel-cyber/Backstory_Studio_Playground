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

  const [byOrg, bySurface, byModel] = await Promise.all([
    systemPrisma.llmCall.groupBy({
      by: ['organizationId'],
      where: { createdAt: { gte: since } },
      _sum: { costUsd: true, inputTokens: true, cacheReadTokens: true, outputTokens: true },
      orderBy: { _sum: { costUsd: 'desc' } },
      take: 50,
    }),
    systemPrisma.llmCall.groupBy({
      by: ['surface'],
      where: { createdAt: { gte: since } },
      _sum: { costUsd: true },
      _count: true,
    }),
    systemPrisma.llmCall.groupBy({
      by: ['provider', 'model', 'priceVersion'],
      where: { createdAt: { gte: since } },
      _sum: { costUsd: true },
      _count: true,
      orderBy: { _sum: { costUsd: 'desc' } },
      take: 50,
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
