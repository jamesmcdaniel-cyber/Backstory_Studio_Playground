import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope } from '@/lib/server/visibility'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const agentId = request.nextUrl.searchParams.get('agentId') || undefined
  const executionId = request.nextUrl.searchParams.get('executionId') || undefined
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 5, 25)
  const visibility = executionVisibilityScope(auth.dbUser.id)

  const executions = executionId
    ? await prisma.agentExecution.findMany({
        where: { id: executionId, organizationId: auth.organizationId, ...visibility },
        omit: { transcript: true },
        take: 1,
      })
    : await prisma.agentExecution.findMany({
        where: {
          organizationId: auth.organizationId,
          ...(agentId ? { agentTaskId: agentId } : {}),
          ...visibility,
        },
        omit: { transcript: true },
        orderBy: { startedAt: 'desc' },
        take: limit,
      })

  const ids = executions.map((execution) => execution.id)
  const [steps, events, messages] = ids.length
    ? await Promise.all([
        prisma.workflowStep.findMany({
          where: { executionId: { in: ids } },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.workflowEvent.findMany({
          where: { executionId: { in: ids } },
          orderBy: { ts: 'asc' },
        }),
        prisma.executionMessage.findMany({
          where: { executionId: { in: ids } },
          orderBy: { createdAt: 'asc' },
        }),
      ])
    : [[], [], []]

  const items = executions.map((execution) => ({
    execution,
    steps: steps.filter((step) => step.executionId === execution.id),
    events: events.filter((event) => event.executionId === execution.id),
    messages: messages.filter((message) => message.executionId === execution.id),
  }))

  return { success: true, items }
}, { permission: 'agent.read' })
