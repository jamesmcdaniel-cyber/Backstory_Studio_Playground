import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { resolveAgentConnectorKeys } from '@/lib/connectors/agent-connectors'
import { agentDefinition, hasUnpublishedChanges, publishedDefinition } from '@/lib/agents/publish'
import { recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'

async function loadAgent(id: string, organizationId: string, userId: string) {
  const agent = await prisma.agentTask.findFirst({
    where: { id, organizationId, deletedAt: null, ...agentVisibilityScope(userId) },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  return agent
}

/** GET — is this agent published, and has the draft moved since? */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const agent = await loadAgent(id, auth.organizationId, auth.dbUser.id)
  const connectorKeys = await resolveAgentConnectorKeys(agent.id, agent.metadata as Record<string, unknown> | null)

  return {
    success: true,
    published: publishedDefinition(agent) !== null,
    publishedAt: agent.publishedAt,
    hasUnpublishedChanges: hasUnpublishedChanges(agent, connectorKeys),
  }
}, { permission: 'agent.read' })

/**
 * POST — publish the draft, or unpublish.
 *
 * Publishing snapshots what the agent DOES: its words and the tools bound to it
 * at that moment. Unpublishing drops the snapshot, which returns the agent to
 * running its live definition — the behaviour every unpublished agent has.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const { unpublish } = z.object({ unpublish: z.boolean().default(false) }).parse(await request.json().catch(() => ({})))

  const agent = await loadAgent(id, auth.organizationId, auth.dbUser.id)

  if (unpublish) {
    if (agent.publishedConfig == null) throw new ApiError('This agent is not published.', 400, 'NOT_PUBLISHED')
    await prisma.agentTask.update({
      where: { id, organizationId: auth.organizationId },
      data: { publishedConfig: Prisma.DbNull, publishedAt: null },
    })
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'agent.unpublished',
      resourceType: 'agent',
      resourceId: id,
      detail: {},
    }).catch(() => undefined)
    return { success: true, published: false }
  }

  const connectorKeys = await resolveAgentConnectorKeys(agent.id, agent.metadata as Record<string, unknown> | null)
  const definition = agentDefinition(agent, connectorKeys)
  const publishedAt = new Date()
  await prisma.agentTask.update({
    where: { id, organizationId: auth.organizationId },
    data: {
      publishedConfig: JSON.parse(JSON.stringify(definition)) as Prisma.InputJsonValue,
      publishedAt,
    },
  })
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'agent.published',
    resourceType: 'agent',
    resourceId: id,
    detail: { connectorKeys: definition.connectorKeys },
  }).catch(() => undefined)

  return { success: true, published: true, publishedAt }
}, { permission: 'agent.write' })
