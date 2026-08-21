import type { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { recordAudit } from '@/lib/audit'
import { supabaseIdentitySweep } from '@/lib/scim/server'
import { listConnectedProviders } from '@/lib/integrations/connected'
// The same "what counts against the 3-integration cap" rule the enforcement
// path uses, so the console cannot disagree with the limit it is reporting on.
import { countableIntegrations } from '@/lib/usage/free-tier-limits'

/**
 * Cross-workspace user observability for platform operators.
 *
 * platform.administer, NOT catalogue.review: the latter is also held by
 * reviewers in PARTNER workspaces, whose remit is moderating shared catalogue
 * content. This route returns every user's personal details across every
 * workspace, so it is gated on the operator tier alone.
 *
 * systemPrisma throughout: reaching across tenants is the entire purpose, which
 * is also why the surface never appears in the customer edition (internalOnly).
 */

/** Windows the UI offers. Anything else falls back to 30. */
const WINDOWS = new Set([7, 30, 90])
const PAGE_SIZE = 200

type Rollup = { runs: number; costUsd: number }

export const GET = withAuthenticatedApi(async (request, auth) => {
  const requested = Number(request.nextUrl.searchParams.get('days'))
  const days = WINDOWS.has(requested) ? requested : 30
  const query = (request.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 200)
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  // Deactivated identities still exist in Supabase and remain available through
  // the explicit recovery view. Deleted identities never belong in this usage
  // report: Supabase Auth is the source of truth for who is a platform user.
  const includeDeactivated = request.nextUrl.searchParams.get('deactivated') === '1'

  // Reconcile BEFORE the database query so orphaned application rows cannot
  // consume the 200-row window or leak into the table/totals. If Supabase is
  // unavailable, fail closed instead of presenting a stale database-only list
  // as an authoritative user roster.
  const identities = await supabaseIdentitySweep()
  if (!identities) {
    throw new ApiError(
      'Could not reconcile the user list with Supabase Auth.',
      503,
      'SUPABASE_IDENTITY_SWEEP_UNAVAILABLE',
    )
  }
  const eligibleSupabaseIds = [...identities.present].filter(
    (id) => includeDeactivated || !identities.disabled.has(id),
  )

  const where: Prisma.UserWhereInput = {
    supabaseId: { in: eligibleSupabaseIds },
    ...(includeDeactivated ? {} : { isActive: true }),
    // Demo orgs (kind === 'demo') are disposable anonymised clones of a real
    // workspace, and User is copied in full into them (see
    // src/lib/demo/snapshot.ts COPY_FULL) — those rows are fictional people,
    // not platform users. `isNot` also holds for a user with no organization
    // at all (organizationId is nullable), so it never drops real orgless
    // accounts. Applied once here: every total below reuses this `where`.
    organization: { isNot: { kind: 'demo' } },
    ...(query ? {
        OR: [
          { email: { contains: query, mode: 'insensitive' as const } },
          { name: { contains: query, mode: 'insensitive' as const } },
        ],
      } : {}),
  }

  const users = await systemPrisma.user.findMany({
    where,
    select: {
      id: true,
      supabaseId: true,
      email: true,
      name: true,
      imageUrl: true,
      timezone: true,
      role: true,
      platformRole: true,
      isActive: true,
      createdAt: true,
      lastSeenAt: true,
      runAllowanceResetAt: true,
      organizationId: true,
      organization: { select: { name: true, slug: true, kind: true } },
    },
    // Most recently active first: the people an operator is looking for are
    // almost always the ones who just did something.
    orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }],
    take: PAGE_SIZE,
  })

  const userIds = users.map((user) => user.id)
  const organizationIds = [...new Set(users.map((user) => user.organizationId).filter((id): id is string => Boolean(id)))]

  // All eligible ids, unbounded — the query above is capped at PAGE_SIZE for
  // the table, but the five tiles above it must share one honest scope: every
  // user this report is entitled to see, not just the 200 most recently
  // active. Enabled = eligible minus whoever Supabase reports as disabled;
  // eligibleSupabaseIds already excludes them unless includeDeactivated is on.
  const enabledSupabaseIds = eligibleSupabaseIds.filter((id) => !identities.disabled.has(id))
  const allEligible = await systemPrisma.user.findMany({ where, select: { id: true } })
  const allEligibleIds = allEligible.map((user) => user.id)

  // Four batched aggregates plus one integration read per DISTINCT workspace —
  // never per user. A naive per-user loop is ~5 queries × 200 rows.
  const [agentRuns, flowRuns, tokens, integrationsByOrg, totalSeen, totalEnabled, totalAgentAgg, totalFlowAgg, totalTokenAgg] =
    await Promise.all([
    systemPrisma.agentExecution.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, startedAt: { gte: since } },
      _count: true,
      _sum: { costUsd: true },
    }),
    systemPrisma.flowRun.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, startedAt: { gte: since } },
      _count: true,
      _sum: { costUsd: true },
    }),
    // Covers BOTH planes: LlmCall.userId is stamped from the owning run, so a
    // person's flow-plane tokens are counted here too. Rows written before that
    // column existed carry no userId and are simply absent — see the schema.
    systemPrisma.llmCall.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds }, createdAt: { gte: since } },
      _sum: { inputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, outputTokens: true },
    }),
    Promise.all(
      organizationIds.map(async (organizationId) => {
        // The connected planes are org-visible (see listConnectedProviders), so
        // this is a workspace figure and the UI labels it as one.
        const providers = await listConnectedProviders(organizationId, '')
        return [
          organizationId,
          { total: providers.length, countable: countableIntegrations(providers) },
        ] as const
      }),
    ),
    // The four totals below are scoped by `allEligibleIds` (unbounded), not
    // `userIds` (the PAGE_SIZE page) — this is what makes the tiles honest
    // for a workspace with more than 200 active accounts.
    systemPrisma.user.count({ where: { ...where, lastSeenAt: { gte: since } } }),
    systemPrisma.user.count({ where: { ...where, supabaseId: { in: enabledSupabaseIds } } }),
    systemPrisma.agentExecution.aggregate({
      where: { userId: { in: allEligibleIds }, startedAt: { gte: since } },
      _sum: { costUsd: true },
    }),
    systemPrisma.flowRun.aggregate({
      where: { userId: { in: allEligibleIds }, startedAt: { gte: since } },
      _sum: { costUsd: true },
    }),
    systemPrisma.llmCall.aggregate({
      where: { userId: { in: allEligibleIds }, createdAt: { gte: since } },
      _sum: { inputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, outputTokens: true },
    }),
  ])

  const agentByUser = new Map<string, Rollup>()
  for (const row of agentRuns) {
    if (row.userId) agentByUser.set(row.userId, { runs: row._count, costUsd: Number(row._sum.costUsd ?? 0) })
  }
  const flowByUser = new Map<string, Rollup>()
  for (const row of flowRuns) {
    if (row.userId) flowByUser.set(row.userId, { runs: row._count, costUsd: Number(row._sum.costUsd ?? 0) })
  }
  const tokensByUser = new Map<string, number>()
  for (const row of tokens) {
    if (!row.userId) continue
    tokensByUser.set(
      row.userId,
      (row._sum.inputTokens ?? 0) +
        (row._sum.cacheReadTokens ?? 0) +
        (row._sum.cacheWriteTokens ?? 0) +
        (row._sum.outputTokens ?? 0),
    )
  }
  const integrations = new Map(integrationsByOrg)

  /**
   * How this row stands against Supabase.
   *
   * 'disabled' is the state that did not exist before: banning is how BOTH
   * deactivation paths are expressed — this console's own deactivate action and
   * the Supabase dashboard's "Ban user" — but a banned identity is still
   * returned by the admin listing, so it used to read as 'present'. Someone
   * revoked in Supabase went on appearing here as an ordinary active account.
   */
  const identityState = (supabaseId: string): 'present' | 'disabled' =>
    identities.disabled.has(supabaseId) ? 'disabled' : 'present'

  // One audit row per view, naming the operator and how wide the look was.
  // Reading a whole platform's personal details is itself a consequential act.
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.userId,
    action: 'platform.users.viewed',
    resourceType: 'user',
    detail: { days, query: query || null, returned: users.length, includeDeactivated },
  })

  return {
    success: true,
    days,
    truncated: users.length === PAGE_SIZE,
    includeDeactivated,
    // Unbounded — every eligible account, not just the PAGE_SIZE page below.
    // All five tiles the page renders share this one scope.
    totals: {
      people: allEligibleIds.length,
      seen: totalSeen,
      enabled: totalEnabled,
      tokens:
        (totalTokenAgg._sum.inputTokens ?? 0) +
        (totalTokenAgg._sum.cacheReadTokens ?? 0) +
        (totalTokenAgg._sum.cacheWriteTokens ?? 0) +
        (totalTokenAgg._sum.outputTokens ?? 0),
      costUsd: Number(totalAgentAgg._sum.costUsd ?? 0) + Number(totalFlowAgg._sum.costUsd ?? 0),
    },
    users: users.map((user) => {
      const agent = agentByUser.get(user.id) ?? { runs: 0, costUsd: 0 }
      const flow = flowByUser.get(user.id) ?? { runs: 0, costUsd: 0 }
      const orgIntegrations = user.organizationId ? integrations.get(user.organizationId) : undefined
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        imageUrl: user.imageUrl,
        timezone: user.timezone,
        role: user.role,
        platformRole: user.platformRole,
        isActive: user.isActive,
        supabaseIdentity: identityState(user.supabaseId),
        createdAt: user.createdAt,
        lastSeenAt: user.lastSeenAt,
        runAllowanceResetAt: user.runAllowanceResetAt,
        organizationId: user.organizationId,
        organizationName: user.organization?.name ?? null,
        organizationKind: user.organization?.kind ?? null,
        agentRuns: agent.runs,
        flowRuns: flow.runs,
        tokens: tokensByUser.get(user.id) ?? 0,
        costUsd: agent.costUsd + flow.costUsd,
        integrations: orgIntegrations?.total ?? 0,
        countableIntegrations: orgIntegrations?.countable ?? 0,
      }
    }),
  }
}, { permission: 'platform.administer', internalOnly: true })
