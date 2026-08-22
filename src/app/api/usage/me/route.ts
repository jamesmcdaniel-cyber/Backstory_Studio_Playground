import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { checkMonthlyTokenBudget, isUsageExemptEmail } from '@/lib/usage/budget'

/**
 * GET /api/usage/me — the signed-in user's OWN month-to-date model usage.
 *
 * Scoped through the ordinary tenant-guarded `prisma` client (organizationId +
 * userId both bound to the caller), never `systemPrisma`: this is the one
 * usage surface every member reaches, so there is no operator-only reach to
 * defend and no reason to step outside RLS.
 *
 * NULL-userId rows (legacy pre-attribution rows, and org-level bench/eval
 * spend such as 'eval_bench') are deliberately excluded from every bucket
 * here rather than folded into "other" — that would either inflate a bucket
 * with spend nobody in particular incurred, or silently vanish it. Their
 * presence is disclosed instead via `hasUnattributedOrgUsage`.
 */

/** Plain-English groupings a member actually asked for, not raw surface strings. */
type Bucket = 'agent' | 'flow' | 'chat' | 'other'
const BUCKET_BY_SURFACE: Record<string, Bucket> = {
  agent_turn: 'agent',
  flow_ai: 'flow',
  // Written by /api/chat, /api/agents/[id]/chat, and
  // /api/flows/copilot/chat (see src/lib/usage/chat-ledger.ts) — every
  // interactive chat surface.
  'run.chat': 'chat',
}
const bucketFor = (surface: string): Bucket => BUCKET_BY_SURFACE[surface] ?? 'other'
const BUCKET_ORDER: Bucket[] = ['agent', 'flow', 'chat', 'other']

type Rollup = {
  calls: number
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number
}
const emptyRollup = (): Rollup => ({ calls: 0, inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0 })
const addInto = (acc: Rollup, row: Rollup): Rollup => ({
  calls: acc.calls + row.calls,
  inputTokens: acc.inputTokens + row.inputTokens,
  cacheWriteTokens: acc.cacheWriteTokens + row.cacheWriteTokens,
  cacheReadTokens: acc.cacheReadTokens + row.cacheReadTokens,
  outputTokens: acc.outputTokens + row.outputTokens,
  costUsd: acc.costUsd + row.costUsd,
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const monthStart = new Date()
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)

  const selfScope = { organizationId: auth.organizationId, userId: auth.dbUser.id, createdAt: { gte: monthStart } }

  const [byModelRows, bySurfaceRows, orgUnattributed, budget] = await Promise.all([
    prisma.llmCall.groupBy({
      by: ['provider', 'model'],
      where: selfScope,
      _count: true,
      _sum: { inputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, outputTokens: true, costUsd: true },
    }),
    prisma.llmCall.groupBy({
      by: ['surface'],
      where: selfScope,
      _count: true,
      _sum: { inputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, outputTokens: true, costUsd: true },
    }),
    // Bench/eval spend and pre-attribution rows are org-level (userId null).
    // Their existence is disclosed via the footnote flag below, never counted
    // into this member's own totals.
    prisma.llmCall.findFirst({
      where: { organizationId: auth.organizationId, userId: null, createdAt: { gte: monthStart } },
      select: { id: true },
    }),
    checkMonthlyTokenBudget(auth.organizationId),
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

  const bucketTotals = new Map<Bucket, Rollup>()
  for (const row of bySurfaceRows as any[]) {
    const bucket = bucketFor(row.surface)
    const rollup = toRollup(row._sum, row._count)
    bucketTotals.set(bucket, addInto(bucketTotals.get(bucket) ?? emptyRollup(), rollup))
  }
  const bySurface = BUCKET_ORDER
    .map((bucket) => ({ bucket, ...(bucketTotals.get(bucket) ?? emptyRollup()) }))
    .filter((row) => row.calls > 0)

  const totals = byModel.reduce<Rollup>((acc, row) => addInto(acc, row), emptyRollup())

  return {
    success: true,
    since: monthStart.toISOString(),
    totals,
    byModel,
    bySurface,
    // Legacy pre-attribution rows and org-level bench/eval spend are grouped
    // out of every bucket above (see selfScope) — this is the honest
    // disclosure that the month's true org spend can exceed what this
    // member's own figures show.
    hasUnattributedOrgUsage: Boolean(orgUnattributed),
    credits: {
      usedTokens: budget.used,
      budgetTokens: budget.limit,
      exempt: isUsageExemptEmail(auth.dbUser.email),
    },
  }
}, { permission: null })
