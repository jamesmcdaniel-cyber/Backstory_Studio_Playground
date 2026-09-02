import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { listAgentCollections, setAgentCollections } from '@/lib/knowledge/collections'
import { RepositoryAssetNotFoundError } from '@/lib/knowledge/repository'

export const runtime = 'nodejs'

/** `/api/agents/{id}/collections` — the id is the second-to-last segment. */
function agentIdFrom(request: Request) {
  return new URL(request.url).pathname.split('/').at(-2) || ''
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  return {
    success: true,
    collectionIds: await listAgentCollections({ organizationId: auth.organizationId, agentId: agentIdFrom(request) }),
  }
}, { permission: 'flow.read' })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ collectionIds: z.array(z.string().min(1)).max(50) }).parse(await request.json())
  try {
    const collectionIds = await setAgentCollections({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      agentId: agentIdFrom(request),
      collectionIds: body.collectionIds,
    })
    return { success: true, collectionIds }
  } catch (error) {
    if (error instanceof RepositoryAssetNotFoundError) throw new ApiError(error.message, 404, 'AGENT_NOT_FOUND')
    throw error
  }
}, { permission: 'flow.write' })
