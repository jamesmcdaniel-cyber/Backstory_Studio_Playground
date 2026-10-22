import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { configurableAgentScope } from '@/lib/server/visibility'
import { resolveAgentScope } from '@/features/agents/agent-scope'

export const runtime = 'nodejs'

/**
 * GET /api/agents/[id]/scope — "What this agent can do", resolved for the
 * person asking through the runtime's own tool resolution: its connections and
 * tools, read vs write, what needs approval, what is blocked and why, whose
 * account each goes out on, its Repository scope and its triggers.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2) || ''
  const agent = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId, status: { not: 'DELETED' }, ...configurableAgentScope(auth.dbUser.id) },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  const scope = await resolveAgentScope({ organizationId: auth.organizationId, agent, viewerUserId: auth.dbUser.id })
  return { success: true, scope }
}, { permission: 'agent.read' })
