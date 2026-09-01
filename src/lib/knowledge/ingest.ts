import { Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { embedTexts, embeddingsConfigured, toSqlVector } from '@/lib/rag/embeddings'
import { saveStoredFile, deleteStoredFile } from '@/lib/files/storage'
import { extractTextAuto, chunkText, isSupported } from './extract'
import { deriveIndexState } from './index-state'
import { DocxExtractionError } from './docx'

// Bound indexing work and prompt surface per asset. The original upload still
// remains downloadable even when its extracted representation is truncated.
export const KNOWLEDGE_MAX_CHARS = 200_000
export const KNOWLEDGE_MAX_CHUNKS = 200
export const KNOWLEDGE_PROCESSING_LEASE_MS = 15 * 60 * 1_000

export class UnsupportedFileError extends Error {}
export class KnowledgeDocumentVersionConflictError extends Error {}

type SourceMetadata = Record<string, unknown>

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue
}

function normalizedContent(raw: string): { text: string; truncated: boolean } {
  const trimmed = raw.trim()
  const text = trimmed.slice(0, KNOWLEDGE_MAX_CHARS)
  if (!text) throw new UnsupportedFileError('No readable text was found in that file.')
  return { text, truncated: trimmed.length > KNOWLEDGE_MAX_CHARS }
}

async function embeddingsFor(
  chunks: string[],
): Promise<{ vectors: number[][] | null; error: string | null }> {
  if (!chunks.length) return { vectors: null, error: null }
  if (!embeddingsConfigured()) {
    return { vectors: null, error: 'No embedding provider is configured for this deployment.' }
  }
  try {
    return { vectors: await embedTexts(chunks, { inputType: 'document' }), error: null }
  } catch (error) {
    // Retrieval degrades to the per-document keyword pass rather than failing
    // the upload — but the reason is persisted so the document can say why it
    // is only keyword-searchable, and so the sweep can retry it.
    const message = error instanceof Error ? error.message : String(error)
    return { vectors: null, error: message.slice(0, 500) }
  }
}

async function writeVectorColumns(
  organizationId: string,
  documentId: string,
  embeddings: number[][] | null,
): Promise<void> {
  if (!embeddings?.length) return
  const created = await prisma.knowledgeChunk.findMany({
    where: { documentId, organizationId },
    orderBy: { ordinal: 'asc' },
    select: { id: true },
  })
  const values = created.map((row, index) =>
    Prisma.sql`(${row.id}::text, ${toSqlVector(embeddings[index])}::vector(1024))`,
  )
  if (!values.length) return
  await tenantTransaction(organizationId, async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
    await tx.$executeRaw`
      UPDATE "knowledge_chunks" AS c
      SET "embeddingVec" = v.vec
      FROM (VALUES ${Prisma.join(values)}) AS v(id, vec)
      WHERE c."id" = v.id AND c."organizationId" = ${organizationId}::uuid
    `
  })
}

/**
 * Atomically replace the indexed representation of one repository asset.
 * Original bytes remain untouched; optional catalogue metadata is updated in
 * the same transaction. Used after ingestion and for user edits.
 */
export async function replaceKnowledgeDocumentContent(params: {
  organizationId: string
  documentId: string
  agentId: string | null
  content: string
  incrementVersion?: boolean
  expectedVersion?: number
  /**
   * Set by a caller that already sliced the text to KNOWLEDGE_MAX_CHARS — the
   * second normalization below cannot see truncation that already happened.
   */
  truncated?: boolean
  metadata?: {
    filename?: string
    description?: string
    isEnabled?: boolean
  }
}) {
  const { text, truncated: contentTruncated } = normalizedContent(params.content)
  const allChunks = chunkText(text)
  const chunks = allChunks.slice(0, KNOWLEDGE_MAX_CHUNKS)
  const truncated = Boolean(params.truncated) || contentTruncated || allChunks.length > KNOWLEDGE_MAX_CHUNKS
  const { vectors: embeddings, error: indexError } = await embeddingsFor(chunks)

  await tenantTransaction(params.organizationId, async (tx) => {
    if (params.incrementVersion) {
      const staleProcessingBefore = new Date(Date.now() - KNOWLEDGE_PROCESSING_LEASE_MS)
      // Claim the version in the same transaction that replaces the chunks.
      // Two editors starting from the same version cannot both delete/write
      // passages even if embedding generation finishes at different times. A
      // crashed worker's processing state becomes recoverable after its lease.
      const claimed = await tx.knowledgeDocument.updateMany({
        where: {
          id: params.documentId,
          organizationId: params.organizationId,
          OR: [
            { status: { not: 'processing' } },
            { status: 'processing', updatedAt: { lt: staleProcessingBefore } },
          ],
          ...(params.expectedVersion !== undefined ? { version: params.expectedVersion } : {}),
        },
        data: { version: { increment: 1 }, status: 'processing', error: null },
      })
      if (claimed.count !== 1) {
        if (params.expectedVersion !== undefined) {
          throw new KnowledgeDocumentVersionConflictError('This asset changed since you opened it. Reload before saving.')
        }
        throw new Error('Repository asset not found.')
      }
    } else {
      const exists = await tx.knowledgeDocument.findFirst({
        where: { id: params.documentId, organizationId: params.organizationId },
        select: { id: true },
      })
      if (!exists) throw new Error('Repository asset not found.')
    }

    await tx.knowledgeChunk.deleteMany({
      where: { documentId: params.documentId, organizationId: params.organizationId },
    })
    if (chunks.length) {
      await tx.knowledgeChunk.createMany({
        data: chunks.map((content, ordinal) => ({
          documentId: params.documentId,
          organizationId: params.organizationId,
          agentId: params.agentId,
          ordinal,
          content,
          embedding: embeddings ? embeddings[ordinal] : undefined,
        })),
      })
    }
    await tx.knowledgeDocument.update({
      where: { id: params.documentId, organizationId: params.organizationId },
      data: {
        content: text,
        charCount: text.length,
        ...(params.metadata?.filename !== undefined ? { filename: params.metadata.filename } : {}),
        ...(params.metadata?.description !== undefined ? { description: params.metadata.description } : {}),
        ...(params.metadata?.isEnabled !== undefined ? { isEnabled: params.metadata.isEnabled } : {}),
        // The version claim above (or initial processing state at creation)
        // keeps retrieval closed until the pgvector copy is also complete.
        status: 'processing',
        error: null,
      },
    })
  })
  try {
    await writeVectorColumns(params.organizationId, params.documentId, embeddings)
    await prisma.knowledgeDocument.update({
      where: { id: params.documentId, organizationId: params.organizationId },
      data: {
        status: 'ready',
        error: null,
        // Derived after the vectors are actually written, so the column
        // reflects what retrieval can see rather than what was attempted.
        indexState: deriveIndexState(chunks.length, embeddings ? chunks.length : 0),
        indexError,
        truncated,
      },
    })
  } catch (error) {
    await prisma.knowledgeDocument.updateMany({
      where: { id: params.documentId, organizationId: params.organizationId },
      data: {
        status: 'failed',
        isEnabled: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      },
    }).catch(() => {})
    throw error
  }
  return { content: text, charCount: text.length, chunkCount: chunks.length }
}

export type KnowledgeTextAssetInput = {
  organizationId: string
  agentId: string | null
  userId: string | null
  filename: string
  mimeType: string
  content: string
  sizeBytes?: number
  description?: string
  storedFileId?: string | null
  assetType?: 'file' | 'pull_artifact' | 'note' | 'project' | 'synced_file'
  sourceType?: 'upload' | 'integration' | 'manual'
  sourceProvider?: string | null
  sourceConnectionId?: string | null
  sourceTool?: string | null
  sourceKey?: string | null
  sourceGroupKey?: string | null
  sourceMetadata?: SourceMetadata
  lastSyncedAt?: Date | null
  /** Set when the caller already truncated `content` (see ingestKnowledgeFile). */
  truncated?: boolean
}

/** Create an editable repository asset from already-extracted or pulled text. */
export async function ingestKnowledgeText(params: KnowledgeTextAssetInput) {
  const { text: content, truncated: contentTruncated } = normalizedContent(params.content)
  const truncated = Boolean(params.truncated) || contentTruncated
  let doc
  try {
    doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId: params.organizationId,
        agentId: params.agentId,
        userId: params.userId,
        filename: params.filename.replace(/[\r\n]/g, ' ').slice(0, 200) || 'content.txt',
        description: params.description?.trim().slice(0, 2_000) ?? '',
        mimeType: params.mimeType || 'text/plain',
        sizeBytes: params.sizeBytes ?? Buffer.byteLength(content, 'utf8'),
        charCount: content.length,
        content,
        storedFileId: params.storedFileId ?? null,
        assetType: params.assetType ?? 'note',
        sourceType: params.sourceType ?? 'manual',
        sourceProvider: params.sourceProvider ?? null,
        sourceConnectionId: params.sourceConnectionId ?? null,
        sourceTool: params.sourceTool ?? null,
        sourceKey: params.sourceKey ?? null,
        sourceGroupKey: params.sourceGroupKey ?? null,
        sourceMetadata: jsonValue(params.sourceMetadata),
        lastSyncedAt: params.lastSyncedAt ?? null,
        status: 'processing',
      },
    })
  } catch (error) {
    // A stored original was reserved before document creation. If the row could
    // not be linked at all, release both quota and object storage.
    if (params.storedFileId) await deleteStoredFile(params.storedFileId, params.organizationId).catch(() => {})
    throw error
  }

  try {
    const indexed = await replaceKnowledgeDocumentContent({
      organizationId: params.organizationId,
      documentId: doc.id,
      agentId: params.agentId,
      content,
      truncated,
    })
    const ready = await prisma.knowledgeDocument.findUnique({
      where: { id: doc.id, organizationId: params.organizationId },
      select: { status: true, isEnabled: true, updatedAt: true },
    })
    return {
      id: doc.id,
      filename: doc.filename,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      charCount: indexed.charCount,
      chunkCount: indexed.chunkCount,
      status: ready?.status ?? 'ready',
      isEnabled: ready?.isEnabled ?? true,
      createdAt: doc.createdAt,
      updatedAt: ready?.updatedAt ?? doc.updatedAt,
    }
  } catch (error) {
    await prisma.knowledgeDocument.updateMany({
      where: { id: doc.id, organizationId: params.organizationId },
      data: {
        status: 'failed',
        isEnabled: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
      },
    }).catch(() => {})
    throw error
  }
}

/**
 * Ingest an upload into the shared repository: validate/extract it, retain the
 * scanned original through StoredFile, then index its editable text.
 */
export async function ingestKnowledgeFile(params: {
  organizationId: string
  agentId: string | null
  userId: string | null
  filename: string
  mimeType: string
  buffer: Buffer
  description?: string
}) {
  if (!isSupported(params.mimeType, params.filename)) {
    throw new UnsupportedFileError(
      'Unsupported file type. Upload PDF, DOCX, text, markdown, CSV, JSON, HTML, or source files.',
    )
  }
  let raw: string
  try {
    raw = await extractTextAuto(params.buffer, params.mimeType, params.filename)
  } catch (error) {
    if (error instanceof DocxExtractionError) throw new UnsupportedFileError(error.message)
    throw error
  }
  // Validate before reserving storage — and capture truncation here, because
  // this slice is what makes the second normalization downstream see a string
  // that is already exactly at the cap.
  const { text: content, truncated } = normalizedContent(raw)
  const stored = await saveStoredFile({
    organizationId: params.organizationId,
    userId: params.userId,
    filename: params.filename,
    mimeType: params.mimeType,
    buffer: params.buffer,
  })

  return ingestKnowledgeText({
    ...params,
    content,
    truncated,
    sizeBytes: params.buffer.length,
    mimeType: stored.mimeType,
    storedFileId: stored.id,
    assetType: 'file',
    sourceType: 'upload',
  })
}
