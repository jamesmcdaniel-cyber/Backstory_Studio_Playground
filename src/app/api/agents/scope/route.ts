import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { configurableAgentScope } from '@/lib/server/visibility'
import { resolveRosterScopes } from '@/features/agents/agent-scope'

export const runtime = 'nodejs'

/**
 * GET /api/agents/scope — the compact scope (counts and badges) for every
 * agent on the caller's roster, keyed by agent id. Same resolution as the full
 * card (/api/agents/[id]/scope); agents sharing an attachment set share one
 * plane load. Fetched after the roster paints, never blocking it.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const agents = await prisma.agentTask.findMany({
    where: { organizationId: auth.organizationId, status: { not: 'DELETED' }, ...configurableAgentScope(auth.dbUser.id) },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  })
  const scopes = await resolveRosterScopes({ organizationId: auth.organizationId, agents, viewerUserId: auth.dbUser.id })
  return { success: true, scopes }
}, { permission: 'agent.read' })
