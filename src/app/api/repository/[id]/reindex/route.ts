import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { findVisibleRepositoryAsset, RepositoryAssetNotFoundError } from '@/lib/knowledge/repository'
import { replaceKnowledgeDocumentContent } from '@/lib/knowledge/ingest'
import { recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'

/** `/api/repository/{id}/reindex` — the id is the second-to-last segment. */
function idFrom(request: Request) {
  return new URL(request.url).pathname.split('/').at(-2) || ''
}

/**
 * Rebuild one asset's chunks and embeddings from its canonical text.
 *
 * The scheduled sweep heals unindexed documents on its own cadence; this is
 * the "don't wait ten minutes" button for someone looking at a Not searchable
 * badge. The retained original in StoredFile is never touched.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const asset = await findVisibleRepositoryAsset({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    id: idFrom(request),
    includeContent: true,
  }).catch((error) => {
    if (error instanceof RepositoryAssetNotFoundError) {
      throw new ApiError(error.message, 404, 'REPOSITORY_ASSET_NOT_FOUND')
    }
    throw error
  })
  if (!asset.content) throw new ApiError('This asset has no indexed text to rebuild.', 409, 'REPOSITORY_ASSET_EMPTY')

  await replaceKnowledgeDocumentContent({
    organizationId: auth.organizationId,
    documentId: asset.id,
    agentId: asset.agentId,
    content: asset.content,
    truncated: asset.truncated,
  })
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'repository.reindexed',
    resourceType: 'repository_asset',
    resourceId: asset.id,
    detail: { filename: asset.filename },
  })
  return {
    success: true,
    asset: await findVisibleRepositoryAsset({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      id: asset.id,
    }),
  }
}, { permission: 'flow.write' })
