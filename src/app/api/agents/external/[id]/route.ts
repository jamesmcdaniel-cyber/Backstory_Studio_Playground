import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { loadExternalAgent, removeExternalAgent, serializeExternalAgent, updateExternalAgent } from '@/lib/agents/external/registry'
import { updateExternalAgentSchema } from '@/lib/agents/external/schemas'

export const runtime = 'nodejs'

/** The agent id: /api/agents/external/[id] (the AgentTask id). */
const agentIdOf = (pathname: string) => pathname.split('/').at(-1) || ''

/**
 * GET — an external agent's delivery settings and health: webhook, reply
 * deadline, last delivery, its reply key's public id. Never a secret.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const row = await loadExternalAgent(auth.organizationId, agentIdOf(request.nextUrl.pathname))
  if (!row) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  return { success: true, externalAgent: serializeExternalAgent(row) }
}, { permission: 'agent.read' })

/** PATCH — edit, pause (`enabled: false`) or resume an external agent. */
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const patch = updateExternalAgentSchema.parse(await request.json())
  const externalAgent = await updateExternalAgent({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    agentId: agentIdOf(request.nextUrl.pathname),
    patch,
  })
  return { success: true, externalAgent }
}, { permission: 'api.manage' })

/** DELETE — remove it: key revoked, endpoint and secret deleted, waiting runs failed. */
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  await removeExternalAgent({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, agentId: agentIdOf(request.nextUrl.pathname) })
  return { success: true }
}, { permission: 'api.manage' })
