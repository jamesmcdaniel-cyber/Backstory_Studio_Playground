import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  deleteRepositoryAsset,
  findVisibleRepositoryAsset,
  RepositoryAssetConflictError,
  RepositoryAssetNotFoundError,
  updateRepositoryAsset,
} from '@/lib/knowledge/repository'
import { recordAudit } from '@/lib/audit'
import { setDocumentCollections } from '@/lib/knowledge/collections'

function idFrom(request: Request) {
  return new URL(request.url).pathname.split('/').at(-1) || ''
}

function repositoryError(error: unknown): never {
  if (error instanceof RepositoryAssetNotFoundError) throw new ApiError(error.message, 404, 'REPOSITORY_ASSET_NOT_FOUND')
  if (error instanceof RepositoryAssetConflictError) throw new ApiError(error.message, 409, 'REPOSITORY_ASSET_STALE')
  throw error
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  try {
    return {
      success: true,
      asset: await findVisibleRepositoryAsset({
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        id: idFrom(request),
        includeContent: true,
      }),
    }
  } catch (error) {
    repositoryError(error)
  }
}, { permission: 'flow.read' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const input = z.object({
    filename: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(2_000).optional(),
    content: z.string().trim().min(1).max(200_000).optional(),
    isEnabled: z.boolean().optional(),
    collectionIds: z.array(z.string().min(1)).max(50).optional(),
    expectedVersion: z.number().int().positive(),
  }).refine((value) =>
    value.filename !== undefined || value.description !== undefined || value.content !== undefined ||
    value.isEnabled !== undefined || value.collectionIds !== undefined,
  'Nothing to update.').parse(await request.json())
  const { collectionIds, ...update } = input
  try {
    let asset = await updateRepositoryAsset({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      id: idFrom(request),
      ...update,
    })
    if (collectionIds !== undefined) {
      await setDocumentCollections({
        organizationId: auth.organizationId,
        documentId: asset.id,
        collectionIds,
      })
      asset = await findVisibleRepositoryAsset({
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        id: asset.id,
      })
    }
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: input.isEnabled === false
        ? 'repository.disabled'
        : input.isEnabled === true
          ? 'repository.enabled'
          : 'repository.edited',
      resourceType: 'repository_asset',
      resourceId: asset.id,
      detail: { fields: Object.keys(input).filter((key) => key !== 'expectedVersion'), version: asset.version },
    })
    return { success: true, asset }
  } catch (error) {
    repositoryError(error)
  }
}, { permission: 'flow.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { confirmation } = z.object({ confirmation: z.string() }).parse(await request.json())
  try {
    const current = await findVisibleRepositoryAsset({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      id: idFrom(request),
    })
    if (confirmation !== current.filename) {
      throw new ApiError('Type the file name to confirm deletion.', 400, 'CONFIRMATION_REQUIRED')
    }
    const deleted = await deleteRepositoryAsset({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      id: current.id,
    })
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'repository.deleted',
      resourceType: 'repository_asset',
      resourceId: deleted.id,
      detail: { filename: deleted.filename },
    })
    return { success: true }
  } catch (error) {
    repositoryError(error)
  }
}, { permission: 'flow.write' })
