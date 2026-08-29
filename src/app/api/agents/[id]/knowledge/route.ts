import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { ingestKnowledgeFile, UnsupportedFileError } from '@/lib/knowledge/ingest'
import { STORED_FILE_MAX_BYTES } from '@/lib/files/storage'
import {
  deleteRepositoryAsset,
  findVisibleRepositoryAsset,
  RepositoryAssetNotFoundError,
} from '@/lib/knowledge/repository'

export const runtime = 'nodejs'

// Max upload size for a knowledge file (pre-extraction).
const MAX_UPLOAD_BYTES = STORED_FILE_MAX_BYTES

/** Resolve the agent id from the path and enforce visibility. */
async function requireAgent(request: Request, auth: { organizationId: string; dbUser: { id: string } }) {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const agent = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId, status: { not: 'DELETED' }, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  return agent.id
}

function serializeDoc(doc: { id: string; filename: string; mimeType: string; sizeBytes: number; charCount: number; status: string; isEnabled: boolean; createdAt: Date; updatedAt: Date; _count?: { chunks: number } }) {
  return {
    id: doc.id,
    filename: doc.filename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    charCount: doc.charCount,
    status: doc.status,
    isEnabled: doc.isEnabled,
    chunkCount: doc._count?.chunks ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    repositoryUrl: '/data-tables',
  }
}

// GET — list this agent's knowledge documents.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const agentId = await requireAgent(request, auth)
  const docs = await prisma.knowledgeDocument.findMany({
    where: { organizationId: auth.organizationId, agentId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { chunks: true } } },
    take: 100,
  })
  return { success: true, documents: docs.map(serializeDoc) }
}, { permission: 'agent.read' })

// POST — upload a file (multipart form-data, field "file") as knowledge.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const agentId = await requireAgent(request, auth)
  const form = await request.formData().catch(() => null)
  const file = form?.get('file')
  if (!(file instanceof File)) throw new ApiError('Attach a file in the "file" field.')
  if (file.size > MAX_UPLOAD_BYTES) throw new ApiError('File is too large (max 10 MB).', 413, 'TOO_LARGE')

  const buffer = Buffer.from(await file.arrayBuffer())
  try {
    const document = await ingestKnowledgeFile({
      organizationId: auth.organizationId,
      agentId,
      userId: auth.dbUser.id,
      filename: file.name || 'upload',
      mimeType: file.type || 'application/octet-stream',
      buffer,
    })
    return { success: true, document }
  } catch (error) {
    if (error instanceof UnsupportedFileError) throw new ApiError(error.message, 415, 'UNSUPPORTED_TYPE')
    throw error
  }
// Multipart upload — raised above the wrapper's 1 MB JSON default to this
// route's own MAX_UPLOAD_BYTES ceiling (plus multipart framing slack), which
// the handler then enforces exactly.
}, { permission: 'agent.write', maxBodyBytes: MAX_UPLOAD_BYTES + 100_000 })

// DELETE — remove a knowledge document (and its chunks, via cascade).
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const agentId = await requireAgent(request, auth)
  const { documentId } = z.object({ documentId: z.string().min(1) }).parse(await request.json())
  try {
    const document = await findVisibleRepositoryAsset({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      id: documentId,
    })
    if (document.agentId !== agentId) throw new RepositoryAssetNotFoundError('Document not found')
    await deleteRepositoryAsset({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      id: documentId,
    })
  } catch (error) {
    if (error instanceof RepositoryAssetNotFoundError) throw new ApiError(error.message, 404, 'NOT_FOUND')
    throw error
  }
  return { success: true }
}, { permission: 'agent.write' })
