import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/**
 * The caller's Ask Backstory conversations: the list the history panel reads,
 * and the clear that makes the widget's Clear mean something.
 *
 * Per user, not per workspace. An admin has no more business reading a rep's
 * help thread than reading their mail, so every query here carries userId
 * beside organizationId — the same line /api/agents/[id]/chat/sessions draws,
 * for the same reason. Widening it to the workspace would be a policy decision,
 * not a refactor.
 *
 * Both handlers sit on `agent.read`, matching that route: the only rows either
 * can reach are the caller's own conversation with the help bot, and ending a
 * conversation you are allowed to hold needs no wider right than holding it.
 */

/** Threads offered in the history panel; older ones stay reachable by id. */
const MAX_SESSIONS = 50

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const sessions = await prisma.librarianChatSession.findMany({
    where: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      // A thread whose model call failed before either turn was written has
      // nothing in it to open, and listing it would offer the user an empty
      // room with no way to tell why. Excluded in SQL rather than after the
      // fetch, so the cap below counts threads that can actually be read: a run
      // of failed questions would otherwise fill the page and push the real
      // conversations out of a list that then renders empty.
      messages: { some: {} },
    },
    orderBy: { updatedAt: 'desc' },
    take: MAX_SESSIONS,
    include: { _count: { select: { messages: true } } },
  })

  return {
    success: true,
    sessions: sessions.map((session) => ({
      id: session.id,
      title: session.title || 'New chat',
      updatedAt: session.updatedAt.toISOString(),
      messageCount: session._count.messages,
    })),
  }
}, { permission: 'agent.read' })

/**
 * Clear: every thread this caller has, gone — in every tab and on every device,
 * which is the whole difference between this and emptying a React array. The
 * turns go with the sessions through the cascade on
 * librarian_chat_messages.sessionId; deleting the threads and orphaning their
 * text would make "cleared" a claim the database contradicts.
 */
export const DELETE = withAuthenticatedApi(async (_request, auth) => {
  const { count } = await prisma.librarianChatSession.deleteMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
  })
  return { success: true, deleted: count }
}, { permission: 'agent.read' })
