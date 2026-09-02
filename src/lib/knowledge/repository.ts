import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { readAgentMetadata } from '@/lib/agents/metadata'
import { deleteStoredFile } from '@/lib/files/storage'
import { KnowledgeDocumentVersionConflictError, replaceKnowledgeDocumentContent } from '@/lib/knowledge/ingest'

export class RepositoryAssetNotFoundError extends Error {}
export class RepositoryAssetConflictError extends Error {}

type RepositoryRow = {
  id: string
  agentId: string | null
  userId: string | null
  filename: string
  description: string
  mimeType: string
  sizeBytes: number
  charCount: number
  content?: string | null
  storedFileId: string | null
  assetType: string
  sourceType: string
  sourceProvider: string | null
  sourceConnectionId: string | null
  sourceTool: string | null
  sourceMetadata: unknown
  isEnabled: boolean
  version: number
  status: string
  error: string | null
  indexState: string
  indexError: string | null
  truncated: boolean
  lastSyncedAt: Date | null
  createdAt: Date
  updatedAt: Date
  _count?: { chunks: number }
  collections?: Array<{ collection: { id: string; name: string } }>
}

function serialize(row: RepositoryRow, agentNames: Map<string, string>) {
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentId ? agentNames.get(row.agentId) ?? 'Agent' : null,
    filename: row.filename,
    description: row.description,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    charCount: row.charCount,
    chunkCount: row._count?.chunks ?? 0,
    hasOriginal: Boolean(row.storedFileId),
    assetType: row.assetType,
    sourceType: row.sourceType,
    sourceProvider: row.sourceProvider,
    sourceConnectionId: row.sourceConnectionId,
    sourceTool: row.sourceTool,
    sourceMetadata: row.sourceMetadata,
    isEnabled: row.isEnabled,
    version: row.version,
    status: row.status,
    error: row.error,
    indexState: row.indexState,
    indexError: row.indexError,
    truncated: row.truncated,
    collections: (row.collections ?? []).map((join) => ({ id: join.collection.id, name: join.collection.name })),
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    downloadUrl: `/api/repository/${row.id}/download`,
  }
}

async function visibleAgents(organizationId: string, userId: string) {
  const agents = await prisma.agentTask.findMany({
    where: {
      organizationId,
      status: { not: 'DELETED' },
      ...agentVisibilityScope(userId),
    },
    select: { id: true, description: true, metadata: true },
    orderBy: { description: 'asc' },
  })
  const options = agents.map((agent) => ({
    id: agent.id,
    title: readAgentMetadata(agent.metadata).title || agent.description.split('\n')[0] || 'Untitled agent',
  }))
  return {
    ids: options.map((agent) => agent.id),
    names: new Map(options.map((agent) => [agent.id, agent.title])),
    agents: options,
  }
}

export async function listRepositoryAssets(params: {
  organizationId: string
  userId: string
  search?: string
  enabled?: boolean
  sourceType?: string
  cursor?: string
  limit?: number
}) {
  const visible = await visibleAgents(params.organizationId, params.userId)
  const search = params.search?.trim().slice(0, 200)
  const matchingAgentIds = search
    ? visible.agents
        .filter((agent) => agent.title.toLowerCase().includes(search.toLowerCase()))
        .map((agent) => agent.id)
    : []
  const visibility: Prisma.KnowledgeDocumentWhereInput = {
    organizationId: params.organizationId,
    OR: [{ agentId: null }, { agentId: { in: visible.ids } }, { userId: params.userId }],
  }
  const where: Prisma.KnowledgeDocumentWhereInput = {
    ...visibility,
    ...(params.enabled === undefined ? {} : { isEnabled: params.enabled }),
    ...(params.sourceType ? { sourceType: params.sourceType } : {}),
    ...(search
      ? {
          AND: [{
            OR: [
              { filename: { contains: search, mode: 'insensitive' } },
              { description: { contains: search, mode: 'insensitive' } },
              { sourceProvider: { contains: search, mode: 'insensitive' } },
              { sourceTool: { contains: search, mode: 'insensitive' } },
              { sourceType: { contains: search, mode: 'insensitive' } },
              ...(matchingAgentIds.length ? [{ agentId: { in: matchingAgentIds } }] : []),
            ],
          }],
        }
      : {}),
  }
  const limit = Math.max(1, Math.min(params.limit ?? 100, 100))
  const rows = await prisma.knowledgeDocument.findMany({
    where,
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    include: {
      _count: { select: { chunks: true } },
      collections: { select: { collection: { select: { id: true, name: true } } } },
    },
    take: limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
  })
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const [total, available, pulls] = await Promise.all([
    prisma.knowledgeDocument.count({ where: visibility }),
    prisma.knowledgeDocument.count({ where: { ...visibility, isEnabled: true, status: 'ready' } }),
    prisma.knowledgeDocument.count({ where: { ...visibility, sourceType: 'integration' } }),
  ])
  return {
    assets: page.map((row) => serialize(row, visible.names)),
    agents: visible.agents,
    nextCursor: hasMore ? page.at(-1)?.id ?? null : null,
    stats: { total, available, pulls },
  }
}

export async function findVisibleRepositoryAsset(params: {
  organizationId: string
  userId: string
  id: string
  includeContent?: boolean
}) {
  const visible = await visibleAgents(params.organizationId, params.userId)
  const row = await prisma.knowledgeDocument.findFirst({
    where: {
      id: params.id,
      organizationId: params.organizationId,
      OR: [{ agentId: null }, { agentId: { in: visible.ids } }, { userId: params.userId }],
    },
    include: {
      _count: { select: { chunks: true } },
      collections: { select: { collection: { select: { id: true, name: true } } } },
    },
  })
  if (!row) throw new RepositoryAssetNotFoundError('Repository asset not found.')

  let content = params.includeContent ? row.content : undefined
  if (params.includeContent && !content) {
    const chunks = await prisma.knowledgeChunk.findMany({
      where: { documentId: row.id, organizationId: params.organizationId },
      orderBy: { ordinal: 'asc' },
      select: { content: true },
    })
    content = chunks.map((chunk) => chunk.content).join('\n\n')
  }
  return { ...serialize({ ...row, content }, visible.names), ...(params.includeContent ? { content: content ?? '' } : {}) }
}

export async function assertRepositoryAgentScope(params: {
  organizationId: string
  userId: string
  agentId?: string | null
}): Promise<string | null> {
  if (!params.agentId) return null
  const visible = await prisma.agentTask.findFirst({
    where: {
      id: params.agentId,
      organizationId: params.organizationId,
      status: { not: 'DELETED' },
      ...agentVisibilityScope(params.userId),
    },
    select: { id: true },
  })
  if (!visible) throw new RepositoryAssetNotFoundError('Agent not found.')
  return visible.id
}

export async function updateRepositoryAsset(params: {
  organizationId: string
  userId: string
  id: string
  expectedVersion: number
  filename?: string
  description?: string
  content?: string
  isEnabled?: boolean
}) {
  const current = await findVisibleRepositoryAsset({
    organizationId: params.organizationId,
    userId: params.userId,
    id: params.id,
  })
  if (current.version !== params.expectedVersion) {
    throw new RepositoryAssetConflictError('This asset changed since you opened it. Reload before saving.')
  }
  if (params.isEnabled === true && current.status !== 'ready') {
    throw new RepositoryAssetConflictError('Only a ready asset can be enabled for agents. Edit and re-index it first.')
  }
  if (params.content !== undefined) {
    const metadata = {
      ...(params.filename !== undefined
        ? { filename: params.filename.replace(/[\r\n]/g, ' ').trim().slice(0, 200) }
        : {}),
      ...(params.description !== undefined ? { description: params.description.trim().slice(0, 2_000) } : {}),
      ...(params.isEnabled !== undefined ? { isEnabled: params.isEnabled } : {}),
    }
    try {
      await replaceKnowledgeDocumentContent({
        organizationId: params.organizationId,
        documentId: params.id,
        agentId: current.agentId,
        content: params.content,
        incrementVersion: true,
        expectedVersion: params.expectedVersion,
        metadata,
      })
    } catch (error) {
      if (error instanceof KnowledgeDocumentVersionConflictError) {
        throw new RepositoryAssetConflictError(error.message)
      }
      throw error
    }
  }
  const hasMetadata = params.filename !== undefined || params.description !== undefined || params.isEnabled !== undefined
  if (hasMetadata && params.content === undefined) {
    const data: Prisma.KnowledgeDocumentUpdateManyMutationInput = {
      ...(params.filename !== undefined
        ? { filename: params.filename.replace(/[\r\n]/g, ' ').trim().slice(0, 200) }
        : {}),
      ...(params.description !== undefined ? { description: params.description.trim().slice(0, 2_000) } : {}),
      ...(params.isEnabled !== undefined ? { isEnabled: params.isEnabled } : {}),
      version: { increment: 1 },
    }
    const updated = await prisma.knowledgeDocument.updateMany({
      where: {
        id: params.id,
        organizationId: params.organizationId,
        version: params.expectedVersion,
      },
      data,
    })
    if (updated.count !== 1) {
      throw new RepositoryAssetConflictError('This asset changed since you opened it. Reload before saving.')
    }
  }
  return findVisibleRepositoryAsset({
    organizationId: params.organizationId,
    userId: params.userId,
    id: params.id,
    includeContent: params.content !== undefined,
  })
}

export async function deleteRepositoryAsset(params: {
  organizationId: string
  userId: string
  id: string
}) {
  const current = await findVisibleRepositoryAsset(params)
  const row = await prisma.knowledgeDocument.findFirst({
    where: { id: current.id, organizationId: params.organizationId },
    select: { storedFileId: true },
  })
  // Remove externally stored bytes first. If storage is unavailable the
  // catalogue entry remains intact and the caller can retry; deleting the row
  // first would strand an object and quota reservation behind a failed request.
  if (row?.storedFileId) await deleteStoredFile(row.storedFileId, params.organizationId)
  await prisma.knowledgeDocument.delete({
    where: { id: current.id, organizationId: params.organizationId },
  })
  return current
}

export async function createFailedPullArtifact(params: {
  organizationId: string
  userId: string
  agentId: string | null
  filename: string
  provider: string
  connectionId: string
  toolName: string
  sourceMetadata: Record<string, unknown>
  error: string
}) {
  return prisma.knowledgeDocument.create({
    data: {
      organizationId: params.organizationId,
      userId: params.userId,
      agentId: params.agentId,
      filename: params.filename.slice(0, 200),
      description: `Failed pull from ${params.provider}`,
      mimeType: 'application/json',
      content: params.error,
      charCount: params.error.length,
      sizeBytes: Buffer.byteLength(params.error),
      assetType: 'pull_artifact',
      sourceType: 'integration',
      sourceProvider: params.provider,
      sourceConnectionId: params.connectionId,
      sourceTool: params.toolName,
      sourceMetadata: JSON.parse(JSON.stringify(params.sourceMetadata)),
      isEnabled: false,
      status: 'failed',
      error: params.error.slice(0, 2_000),
      lastSyncedAt: new Date(),
    },
  })
}
