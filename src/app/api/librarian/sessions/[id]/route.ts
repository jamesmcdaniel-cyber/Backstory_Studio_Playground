import type { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/**
 * One Ask Backstory conversation: its turns for a reload, or its deletion.
 *
 * The id in the path is NOT a capability. Every query below matches on
 * organizationId and userId as well, so another user's thread — or another
 * workspace's — resolves to nothing rather than to a 403. The difference is
 * what the two answers admit: a permission error confirms that the thread
 * exists and says whose it is not, and confirming that for an id someone can
 * guess is the whole of the leak. The tenant guard in lib/tenant-guard.ts makes
 * the org half of that scoping structural — an unscoped query throws — but the
 * per-user half is this file's to hold.
 *
 * Both handlers sit on `agent.read`, matching /api/agents/[id]/chat/sessions.
 */

/** Turns returned for a restored thread — the most recent, if it ran long. */
const MAX_MESSAGES = 100

/**
 * The thread id: the segment after `sessions`, anchored the way
 * api/agents/[id]/chat reads its agent id rather than taken off the end of the
 * path, so a trailing slash or a segment nested under this route later resolves
 * to nothing instead of to some other part of the URL.
 *
 * A missing id comes back empty rather than thrown, because empty and
 * not-yours are the same answer here: every query below matches on the id, and
 * no row's id is ''.
 */
function sessionIdFrom(request: NextRequest): string {
  const segments = request.nextUrl.pathname.split('/')
  return segments[segments.indexOf('sessions') + 1] || ''
}

/**
 * A stored turn as the widget renders it.
 *
 * The cards and citations come back out of `metadata` exactly as the answer
 * shipped with them, so every link in a restored thread is still one the route
 * resolved when it answered — a reload cannot acquire a URL nobody fetched.
 * Shape-checked on the way out because `metadata` is free-form JSON: rows
 * written by an older version of the route are missing halves of it, and a
 * thread from last month must still open.
 */
function serializeTurn(row: { id: string; role: string; content: string; metadata: unknown; createdAt: Date }) {
  const metadata =
    row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {}
  return {
    id: row.id,
    // `role` is a free-form column with no CHECK behind it, so this mapping is
    // total and everything that is not an assistant turn renders as the user's.
    // That is the direction that grants nothing: a row with an unexpected role
    // shows up as something the person said, never as something the product
    // said, which is the half a reader would take on trust.
    role: row.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    results: Array.isArray(metadata.results) ? metadata.results : [],
    sources: Array.isArray(metadata.sources) ? metadata.sources : [],
  }
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const session = await prisma.librarianChatSession.findFirst({
    where: { id: sessionIdFrom(request), organizationId: auth.organizationId, userId: auth.dbUser.id },
    select: { id: true, title: true, updatedAt: true },
  })
  // An id that is not this caller's own reads exactly like a thread they
  // cleared from another tab: no session, no turns, no error. The widget
  // restores a pointer it may have stored days ago, so "that conversation is
  // gone" has to be an ordinary answer rather than a failure it has to handle —
  // and the two cases must be indistinguishable from outside anyway.
  if (!session) return { success: true, session: null, messages: [] }

  const rows = await prisma.librarianChatMessage.findMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id, sessionId: session.id },
    // Newest first under the cap, then reversed for display: a thread longer
    // than the ceiling should open on the end the user was last reading. The id
    // breaks a createdAt tie in creation order (cuids are ordered within a
    // process), so a question never renders below its own answer.
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_MESSAGES,
    select: { id: true, role: true, content: true, metadata: true, createdAt: true },
  })

  return {
    success: true,
    session: {
      id: session.id,
      title: session.title || 'New chat',
      updatedAt: session.updatedAt.toISOString(),
    },
    messages: rows.reverse().map(serializeTurn),
  }
}, { permission: 'agent.read' })

/**
 * Delete one thread. Its turns go with it through the cascade on
 * librarian_chat_messages.sessionId.
 *
 * `deleteMany` rather than `delete`: `delete` throws on a row it cannot find,
 * which would answer for an id the caller does not own — and a delete that is
 * idempotent is also the one a client can safely retry.
 */
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { count } = await prisma.librarianChatSession.deleteMany({
    where: { id: sessionIdFrom(request), organizationId: auth.organizationId, userId: auth.dbUser.id },
  })
  return { success: true, deleted: count }
}, { permission: 'agent.read' })
