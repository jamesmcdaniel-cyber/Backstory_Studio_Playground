import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { nativeFlowPackage } from '@/lib/flows/native-package'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  const flow = id ? await prisma.flow.findFirst({ where: { id, organizationId: auth.organizationId } }) : null
  if (!flow) throw new ApiError('Flow not found.', 404, 'NOT_FOUND')
  return Response.json(nativeFlowPackage(flow), {
    headers: { 'content-disposition': `attachment; filename="${flow.name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'flow'}.backstory.json"` },
  })
}, { permission: 'flow.read' })
