import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { executionVisibilityScope } from '@/lib/server/visibility'
import { removeExecutionFromGraph } from '@/lib/rag/indexer'

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-1)
  if (!id) throw new ApiError('Execution id is required')
  // Cascade removes workflow steps/events/messages via the schema relations.
  const result = await prisma.agentExecution.deleteMany({
    where: { id, organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) },
  })
  if (!result.count) throw new ApiError('Execution not found', 404, 'NOT_FOUND')
  // Drop the run's graph node so it can't resurface in retrieval. Best-effort.
  void removeExecutionFromGraph(auth.organizationId, id).catch(() => undefined)
  return { success: true }
}, { permission: 'agent.write' })
