import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope, executionVisibilityScope } from '@/lib/server/visibility'
import { serializeAgent } from '@/lib/agents/serialize'
import { isUsageExemptEmail } from '@/lib/usage/budget'

export const runtime = 'nodejs'

/**
 * GET /api/snapshot — everything the app shell polls, in ONE request.
 *
 * The dashboard, sidebar, and notification bell used to poll five separate
 * endpoints (/agents, /agents/activity, /usage, /organizations,
 * /notifications), each paying its own auth + function invocation — ~6
 * authenticated requests per user per poll cycle. This endpoint answers all
 * of them with a single auth and five parallel queries, so the app shell
 * costs one request per cycle regardless of how many widgets poll.
 *
 * Response sub-shapes are IDENTICAL to the individual endpoints (agents via
 * the shared serializer, activity lean rows, usage aggregate, organizations
 * list, notifications + unread) so consumers can switch freely.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const notificationScope = { organizationId: auth.organizationId, OR: [{ userId: auth.dbUser.id }, { userId: null }] }

  const [agents, activities, usageAggregate, organization, notifications, unread] = await Promise.all([
    prisma.agentTask.findMany({
      where: {
        organizationId: auth.organizationId,
        status: { not: 'DELETED' },
        ...agentVisibilityScope(auth.dbUser.id),
      },
      orderBy: { updatedAt: 'desc' },
      take: 300,
    }),
    prisma.agentExecution.findMany({
      where: { organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) },
      omit: { transcript: true, input: true },
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
    prisma.agentExecution.aggregate({
      where: { organizationId: auth.organizationId, startedAt: { gte: monthStart } },
      _sum: { inputTokens: true, outputTokens: true },
      _count: true,
    }),
    prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { id: true, name: true, slug: true, plan: true, logoUrl: true },
    }),
    prisma.notification.findMany({ where: notificationScope, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.notification.count({ where: { ...notificationScope, readAt: null } }),
  ])

  return {
    success: true,
    agents: agents.map(serializeAgent),
    activities,
    usage: {
      since: monthStart.toISOString(),
      executions: usageAggregate._count,
      inputTokens: usageAggregate._sum.inputTokens || 0,
      outputTokens: usageAggregate._sum.outputTokens || 0,
      // Exempt admins have no ceiling — the sidebar shows "Unlimited".
      exempt: isUsageExemptEmail(auth.dbUser.email),
    },
    activeOrganizationId: auth.organizationId,
    organizations: organization ? [organization] : [],
    notifications,
    unread,
  }
}, { permission: 'agent.read' })
