import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Month-to-date model usage for the organization — the metering basis for
// a credits display.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const since = new Date()
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)

  const aggregate = await prisma.agentExecution.aggregate({
    where: { organizationId: auth.organizationId, startedAt: { gte: since } },
    _sum: { inputTokens: true, outputTokens: true },
    _count: true,
  })

  return {
    success: true,
    usage: {
      since: since.toISOString(),
      executions: aggregate._count,
      inputTokens: aggregate._sum.inputTokens || 0,
      outputTokens: aggregate._sum.outputTokens || 0,
    },
  }
}, { permission: null })
