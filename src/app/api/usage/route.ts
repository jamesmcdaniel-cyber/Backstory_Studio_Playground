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
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const since = new Date()
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)

  const [aggregate, budget] = await Promise.all([
    prisma.agentExecution.aggregate({
      where: { organizationId: auth.organizationId, startedAt: { gte: since } },
      _sum: { inputTokens: true, outputTokens: true },
      _count: true,
    }),
    checkMonthlyTokenBudget(auth.organizationId),
  ])

  return {
    success: true,
    usage: {
      since: since.toISOString(),
      executions: aggregate._count,
      inputTokens: aggregate._sum.inputTokens || 0,
      outputTokens: aggregate._sum.outputTokens || 0,
      usedTokens: budget.used,
      budgetTokens: budget.limit,
    },
  }
}, { permission: null })
