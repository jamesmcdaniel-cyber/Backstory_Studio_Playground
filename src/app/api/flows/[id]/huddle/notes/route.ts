import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'

// GET /api/flows/[id]/huddle/notes — the flow's huddle notes, newest first.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-3)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const notes = await prisma.huddleNote.findMany({
    where: { flowId: flow.id, organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  return { success: true, notes }
}, { permission: 'flow.read' })
