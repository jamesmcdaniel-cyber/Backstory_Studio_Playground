import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { nativeFlowPackage } from '@/lib/flows/native-package'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  // Visibility scope, like every other single-flow route: without it a VIEWER
  // could export another member's PRIVATE flow — the whole graph, prompts and
  // bindings included — from an id that GET /api/flows/[id] already 404s.
  const flow = id
    ? await prisma.flow.findFirst({ where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) } })
    : null
  if (!flow) throw new ApiError('Flow not found.', 404, 'NOT_FOUND')
  return Response.json(nativeFlowPackage(flow), {
    headers: { 'content-disposition': `attachment; filename="${flow.name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'flow'}.backstory.json"` },
  })
}, { permission: 'flow.read' })
