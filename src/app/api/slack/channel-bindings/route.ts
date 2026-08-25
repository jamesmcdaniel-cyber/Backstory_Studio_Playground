import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/**
 * Which teammate a bare @mention reaches in a given Slack channel.
 *
 * The agent is tenant-checked on write, deliberately: the foreign key alone
 * accepts ANY org's agent id, which would file a binding onto a stranger's
 * roster and route that channel's mentions into another workspace.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const bindings = await prisma.slackChannelBinding.findMany({
    where: { organizationId: auth.organizationId },
    select: { channelId: true, agentTaskId: true, updatedAt: true },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  return { success: true, bindings }
}, { permission: 'agent.read' })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const { channelId, agentTaskId } = z
    .object({ channelId: z.string().trim().min(1).max(64), agentTaskId: z.string().min(1) })
    .parse(await request.json())

  const agent = await prisma.agentTask.findFirst({
    where: { id: agentTaskId, organizationId: auth.organizationId, status: { not: 'DELETED' } },
    select: { id: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')

  const binding = await prisma.slackChannelBinding.upsert({
    where: { organizationId_channelId: { organizationId: auth.organizationId, channelId } },
    update: { agentTaskId },
    create: { organizationId: auth.organizationId, channelId, agentTaskId },
    select: { channelId: true, agentTaskId: true },
  })
  return { success: true, binding }
}, { permission: 'agent.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { channelId } = z.object({ channelId: z.string().trim().min(1) }).parse(await request.json())
  await prisma.slackChannelBinding.deleteMany({
    where: { organizationId: auth.organizationId, channelId },
  })
  return { success: true }
}, { permission: 'agent.write' })
