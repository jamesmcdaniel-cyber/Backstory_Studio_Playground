import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentIdFromRequest, requireAgent, LEGACY_SESSION_ID } from '../shared'

export const runtime = 'nodejs'

/**
 * Lists the current user's assistant conversations for one agent, newest first.
 * History is per agent + per rep. A pre-sessions flat thread (messages with no
 * sessionId) surfaces as a single synthetic "Earlier conversation".
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const agentId = agentIdFromRequest(request)
  await requireAgent(agentId, auth)

  const sessions = await prisma.agentChatSession.findMany({
    where: { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { _count: { select: { messages: true } } },
  })

  const list = sessions
    .filter((session) => session._count.messages > 0)
    .map((session) => ({
      id: session.id,
      title: session.title || 'New chat',
      updatedAt: session.updatedAt.toISOString(),
      messageCount: session._count.messages,
    }))

  // Legacy flat thread → one read-only synthetic session, ordered by its most
  // recent message so it sorts naturally among real sessions.
  const legacyCount = await prisma.agentChatMessage.count({
    where: { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id, sessionId: null },
  })
  if (legacyCount > 0) {
    const latest = await prisma.agentChatMessage.findFirst({
      where: { organizationId: auth.organizationId, agentTaskId: agentId, userId: auth.dbUser.id, sessionId: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    list.push({
      id: LEGACY_SESSION_ID,
      title: 'Earlier conversation',
      updatedAt: (latest?.createdAt ?? new Date(0)).toISOString(),
      messageCount: legacyCount,
    })
  }

  list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
  return { success: true, sessions: list }
}, { permission: 'agent.read' })
