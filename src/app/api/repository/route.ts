import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { STORED_FILE_MAX_BYTES } from '@/lib/files/storage'
import { ingestKnowledgeFile, UnsupportedFileError } from '@/lib/knowledge/ingest'
import {
  assertRepositoryAgentScope,
  listRepositoryAssets,
  RepositoryAssetNotFoundError,
} from '@/lib/knowledge/repository'
import { recordAudit } from '@/lib/audit'
import { setDocumentCollections } from '@/lib/knowledge/collections'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const enabledRaw = request.nextUrl.searchParams.get('enabled')
  const enabled = enabledRaw === 'true' ? true : enabledRaw === 'false' ? false : undefined
  const sourceTypeRaw = request.nextUrl.searchParams.get('sourceType')
  const sourceType = sourceTypeRaw && ['upload', 'integration', 'manual'].includes(sourceTypeRaw)
    ? sourceTypeRaw
    : undefined
  const limitRaw = Number(request.nextUrl.searchParams.get('limit'))
  const result = await listRepositoryAssets({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    search: request.nextUrl.searchParams.get('q') || undefined,
    enabled,
    sourceType,
    cursor: request.nextUrl.searchParams.get('cursor')?.slice(0, 200) || undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
  })
  return { success: true, ...result }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) throw new ApiError('Choose a file to upload.', 400, 'FILE_REQUIRED')
  if (file.size > STORED_FILE_MAX_BYTES) {
    throw new ApiError(`Files can be at most ${Math.round(STORED_FILE_MAX_BYTES / 1_000_000)} MB.`, 413, 'FILE_TOO_LARGE')
  }
  const agentIdRaw = form?.get('agentId')
  const descriptionRaw = form?.get('description')
  // Optional collection membership, as a JSON array in a form field. Invalid
  // JSON degrades to no collections rather than failing the upload.
  const collectionIdsRaw = form?.get('collectionIds')
  const collectionIds: string[] = (() => {
    if (typeof collectionIdsRaw !== 'string' || !collectionIdsRaw.trim()) return []
    try {
      const parsed = JSON.parse(collectionIdsRaw)
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, 50) : []
    } catch {
      return []
    }
  })()
  const agentId = await assertRepositoryAgentScope({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    agentId: typeof agentIdRaw === 'string' ? agentIdRaw : null,
  }).catch((error) => {
    if (error instanceof RepositoryAssetNotFoundError) throw new ApiError(error.message, 404, 'AGENT_NOT_FOUND')
    throw error
  })

  try {
    const document = await ingestKnowledgeFile({
      organizationId: auth.organizationId,
      agentId,
      userId: auth.dbUser.id,
      filename: file.name || 'upload',
      mimeType: file.type || 'application/octet-stream',
      buffer: Buffer.from(await file.arrayBuffer()),
      description: typeof descriptionRaw === 'string' ? descriptionRaw : undefined,
    })
    if (collectionIds.length) {
      await setDocumentCollections({
        organizationId: auth.organizationId,
        documentId: document.id,
        collectionIds,
      })
    }
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'repository.uploaded',
      resourceType: 'repository_asset',
      resourceId: document.id,
      detail: { filename: document.filename, sizeBytes: document.sizeBytes, agentId },
    })
    return { success: true, document }
  } catch (error) {
    if (error instanceof UnsupportedFileError) throw new ApiError(error.message, 415, 'UNSUPPORTED_TYPE')
    throw error
  }
}, { permission: 'flow.write', maxBodyBytes: STORED_FILE_MAX_BYTES + 100_000 })
