import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'

// Month-to-date model usage for the organization — the metering basis for
// a credits display.
//
// usedTokens/budgetTokens share their source with /api/snapshot and the
// run-time enforcement gate (checkMonthlyTokenBudget: LlmCall sums across
// both the agent and flow planes, plus the workspace's enforced ceiling) so
// this and the snapshot endpoint can never disagree about "how much have we
// used." inputTokens/outputTokens/executions stay for existing consumers,
// unchanged in shape.
//
// AgentExecution.inputTokens now means fresh (non-cached) prompt tokens only
// (see the schema doc-comment) — cache reads/writes moved to their own
// columns. This endpoint's `inputTokens` field still means the OLD total
// (everything sent, cache included), so it sums all three columns rather than
// reading inputTokens alone: a legacy row (cache folded in, both cache columns
// 0) and a post-split row report the same total either way.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const since = new Date()
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)

  const [aggregate, budget] = await Promise.all([
    prisma.agentExecution.aggregate({
      where: { organizationId: auth.organizationId, startedAt: { gte: since } },
      _sum: { inputTokens: true, cacheReadTokens: true, cacheWriteTokens: true, outputTokens: true },
      _count: true,
    }),
    checkMonthlyTokenBudget(auth.organizationId),
  ])

  return {
    success: true,
    usage: {
      since: since.toISOString(),
      executions: aggregate._count,
      inputTokens:
        (aggregate._sum.inputTokens || 0) +
        (aggregate._sum.cacheReadTokens || 0) +
        (aggregate._sum.cacheWriteTokens || 0),
      outputTokens: aggregate._sum.outputTokens || 0,
      usedTokens: budget.used,
      budgetTokens: budget.limit,
    },
  }
}, { permission: null })
