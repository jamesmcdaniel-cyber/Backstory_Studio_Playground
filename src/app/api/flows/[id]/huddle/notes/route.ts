import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { transcriptionAvailable } from '@/lib/flows/huddle-transcribe'

// GET /api/flows/[id]/huddle/notes — the flow's huddle notes, newest first,
// plus whether capture is even possible (the toggle is disabled with an
// explanation when transcription isn't configured, instead of failing at the
// end of a call).
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
  return {
    success: true,
    notes,
    captureAvailable: transcriptionAvailable({ OPENAI_API_KEY: process.env.OPENAI_API_KEY }),
  }
}, { permission: 'flow.read' })
