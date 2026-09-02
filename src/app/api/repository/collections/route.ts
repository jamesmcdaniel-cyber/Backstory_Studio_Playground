import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { listCollections, createCollection, CollectionNotFoundError } from '@/lib/knowledge/collections'
import { recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (_request, auth) => {
  return { success: true, collections: await listCollections({ organizationId: auth.organizationId }) }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
  }).parse(await request.json())
  try {
    const collection = await createCollection({ organizationId: auth.organizationId, ...body })
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'repository.collection_created',
      resourceType: 'knowledge_collection',
      resourceId: collection.id,
      detail: { name: collection.name },
    })
    return { success: true, collection }
  } catch (error) {
    if (error instanceof CollectionNotFoundError) throw new ApiError(error.message, 400, 'COLLECTION_INVALID')
    throw error
  }
}, { permission: 'flow.write' })
