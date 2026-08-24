import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope, executionVisibilityScope } from '@/lib/server/visibility'
import { serializeAgent } from '@/lib/agents/serialize'
import { checkMonthlyTokenBudget, isUsageExemptEmail } from '@/lib/usage/budget'
import { readSnapshotVersion } from '@/lib/server/snapshot-version'

export const runtime = 'nodejs'

/**
 * GET /api/snapshot — everything the app shell polls, in ONE request.
 *
 * The dashboard, sidebar, and notification bell used to poll five separate
 * endpoints (/agents, /agents/activity, /usage, /organizations,
 * /notifications), each paying its own auth + function invocation — ~6
 * authenticated requests per user per poll cycle. This endpoint answers all
 * of them with a single auth and parallel queries, so the app shell
 * costs one request per cycle regardless of how many widgets poll.
 *
 * Response sub-shapes are IDENTICAL to the individual endpoints (agents via
 * the shared serializer, activity lean rows, usage aggregate, organizations
 * list, notifications + unread) so consumers can switch freely.
 */
/**
 * The validator for a snapshot response.
 *
 * Three components, each because leaving it out produces a wrong answer:
 *   version — the workspace's mutation counter (snapshot-version.ts). Moves
 *             whenever anything this endpoint reads is written.
 *   userId  — the response is filtered by per-user visibility scope and carries
 *             that person's notifications, so two members of one workspace at
 *             the same version hold genuinely different bodies.
 *   month   — the usage window is month-to-date. Without this, the first poll
 *             after a UTC month boundary would revalidate against a body whose
 *             counters had silently reset, in a quiet workspace possibly for
 *             hours.
 */
function snapshotEtag(version: number, userId: string, monthStart: Date): string {
  return `W/"snap1-${version}-${userId}-${monthStart.getUTCFullYear()}${monthStart.getUTCMonth() + 1}"`
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  // The point of the whole mechanism: when the client's copy is still current,
  // answer without touching Postgres at all. At 1,000 concurrent users the shell
  // poll is ~125 req/s and ~1,100 queries/s, the overwhelming majority of it
  // re-reading unchanged rows. A matching validator turns each of those into one
  // cache read.
  //
  // `readSnapshotVersion` returns null when no cache backend is configured or it
  // is unreachable. That path emits no ETag and runs the queries exactly as this
  // route did before — degraded to slower, never to stale.
  const version = await readSnapshotVersion(auth.organizationId)
  const etag = version === null ? null : snapshotEtag(version, auth.dbUser.id, monthStart)
  if (etag && request.headers.get('if-none-match') === etag) {
    // 304 carries no body by definition, and must repeat the validator so the
    // client can revalidate against it again next cycle.
    return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'private, no-cache' } })
  }

  const notificationScope = { organizationId: auth.organizationId, OR: [{ userId: auth.dbUser.id }, { userId: null }] }

  const [agents, workspaceFolders, activities, executionCount, budget, organization, notifications, unread] = await Promise.all([
    prisma.agentTask.findMany({
      where: {
        organizationId: auth.organizationId,
        status: { not: 'DELETED' },
        ...agentVisibilityScope(auth.dbUser.id),
      },
      orderBy: { updatedAt: 'desc' },
      take: 300,
    }),
    prisma.workspaceFolder.findMany({
      where: { organizationId: auth.organizationId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.agentExecution.findMany({
      where: { organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) },
      omit: { transcript: true, input: true },
      orderBy: { startedAt: 'desc' },
      take: 50,
    }),
    prisma.agentExecution.count({
      where: { organizationId: auth.organizationId, startedAt: { gte: monthStart } },
    }),
    // The same enforcement source of truth the run-time gate checks — LlmCall
    // token sums across BOTH planes (agent turns and flow AI steps) plus the
    // workspace's enforced ceiling — so the number the sidebar shows and the
    // number that stops a run are never two different sources.
    checkMonthlyTokenBudget(auth.organizationId),
    prisma.organization.findUnique({
      where: { id: auth.organizationId },
      select: { id: true, name: true, slug: true, plan: true, logoUrl: true },
    }),
    prisma.notification.findMany({ where: notificationScope, orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.notification.count({ where: { ...notificationScope, readAt: null } }),
  ])

  const body = {
    success: true,
    agents: agents.map(serializeAgent),
    workspaceFolders,
    activities,
    usage: {
      since: monthStart.toISOString(),
      executions: executionCount,
      usedTokens: budget.used,
      budgetTokens: budget.limit,
      // Exempt admins have no ceiling — the sidebar shows "Unlimited".
      exempt: isUsageExemptEmail(auth.dbUser.email),
    },
    activeOrganizationId: auth.organizationId,
    organizations: organization ? [organization] : [],
    notifications,
    unread,
  }

  // Stamped with the version read BEFORE the queries ran, and that ordering is
  // the whole safety argument. A write landing mid-flight advances the counter,
  // so this body is labelled with the older number: the client's next poll
  // presents a stale validator, misses, and recomputes. Re-reading the counter
  // here would do the opposite — label a body that may predate the write with
  // the post-write number, and the client would then revalidate successfully
  // against data that never contained it, indefinitely.
  //
  // The failure this direction can produce is one unnecessary recompute. The
  // other direction produces a shell that is silently wrong.
  return Response.json(body, {
    headers: etag
      ? { ETag: etag, 'Cache-Control': 'private, no-cache' }
      : { 'Cache-Control': 'private, no-store' },
  })
}, { permission: 'agent.read' })
