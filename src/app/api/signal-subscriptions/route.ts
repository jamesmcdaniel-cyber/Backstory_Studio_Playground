import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { SIGNAL_TYPES } from '@/lib/signals/map'

// Routing rules that turn People.ai signals into agent runs. Org-scoped.

const createSchema = z.object({
  signalType: z.enum(SIGNAL_TYPES as unknown as [string, ...string[]]),
  agentTaskId: z.string().min(1),
  filter: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  isActive: z.boolean().default(true),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const subscriptions = await prisma.signalSubscription.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
    include: { agentTask: { select: { id: true, description: true } } },
  })
  return { success: true, subscriptions }
}, { permission: 'agent.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = createSchema.parse(await request.json())

  // The target agent must belong to this workspace.
  const agent = await prisma.agentTask.findFirst({
    where: { id: input.agentTaskId, organizationId: auth.organizationId },
    select: { id: true },
  })
  if (!agent) throw new ApiError('Agent not found in this workspace', 404, 'AGENT_NOT_FOUND')

  const subscription = await prisma.signalSubscription.create({
    data: {
      organizationId: auth.organizationId,
      signalType: input.signalType,
      agentTaskId: input.agentTaskId,
      filter: input.filter,
      isActive: input.isActive,
      createdById: auth.dbUser.id,
    },
  })
  return { success: true, subscription }
}, { permission: 'agent.write' })
