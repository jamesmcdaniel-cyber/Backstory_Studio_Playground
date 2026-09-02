import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { renameCollection, deleteCollection, CollectionNotFoundError } from '@/lib/knowledge/collections'
import { recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'

function idFrom(request: Request) {
  return new URL(request.url).pathname.split('/').at(-1) || ''
}

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).optional(),
  }).parse(await request.json())
  try {
    const collection = await renameCollection({ organizationId: auth.organizationId, id: idFrom(request), ...body })
    return { success: true, collection }
  } catch (error) {
    if (error instanceof CollectionNotFoundError) throw new ApiError(error.message, 404, 'COLLECTION_NOT_FOUND')
    throw error
  }
}, { permission: 'flow.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request)
  try {
    await deleteCollection({ organizationId: auth.organizationId, id })
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'repository.collection_deleted',
      resourceType: 'knowledge_collection',
      resourceId: id,
    })
    return { success: true, id }
  } catch (error) {
    if (error instanceof CollectionNotFoundError) throw new ApiError(error.message, 404, 'COLLECTION_NOT_FOUND')
    throw error
  }
}, { permission: 'flow.write' })
