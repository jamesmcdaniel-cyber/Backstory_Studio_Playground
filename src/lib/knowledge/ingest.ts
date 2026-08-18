import { prisma, tenantTransaction } from '@/lib/prisma'
import { embedTexts, embeddingsConfigured, toSqlVector } from '@/lib/rag/embeddings'
import { extractTextAuto, chunkText, isSupported } from './extract'
import { DocxExtractionError } from './docx'
import { Prisma } from '@prisma/client'

// Bound the work per upload: cap extracted text and chunk count so one huge file
// can't dominate storage or the embeddings bill.
const MAX_CHARS = 200_000
const MAX_CHUNKS = 200

export class UnsupportedFileError extends Error {}

/**
 * Ingest an uploaded file as agent knowledge: extract text, chunk it, embed the
 * chunks (when embeddings are configured), and persist the document + chunks.
 * Only the extracted text is stored — never the original binary.
 */
export async function ingestKnowledgeFile(params: {
  organizationId: string
  agentId: string | null
  userId: string | null
  filename: string
  mimeType: string
  buffer: Buffer
}) {
  if (!isSupported(params.mimeType, params.filename)) {
    throw new UnsupportedFileError(
      'Unsupported file type. Upload PDF, DOCX, text, markdown, CSV, JSON, HTML, or source files.',
    )
  }
  // A file whose type we accept but whose bytes we cannot read (corrupt or
  // password-protected DOCX, say) is rejected with the reader's own message —
  // never ingested as a partial or empty document.
  let raw: string
  try {
    raw = await extractTextAuto(params.buffer, params.mimeType, params.filename)
  } catch (error) {
    if (error instanceof DocxExtractionError) throw new UnsupportedFileError(error.message)
    throw error
  }
  if (!raw) throw new UnsupportedFileError('No readable text was found in that file.')
  const text = raw.slice(0, MAX_CHARS)
  const chunks = chunkText(text).slice(0, MAX_CHUNKS)

  const doc = await prisma.knowledgeDocument.create({
    data: {
      organizationId: params.organizationId,
      agentId: params.agentId,
      userId: params.userId,
      filename: params.filename,
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
      charCount: text.length,
      status: 'ready',
    },
  })

  // Embed the chunks up front so retrieval is fast; degrade to keyword search
  // (no embedding stored) when embeddings aren't configured or the call fails.
  let embeddings: number[][] | null = null
  if (embeddingsConfigured() && chunks.length) {
    try {
      embeddings = await embedTexts(chunks, { inputType: 'document' })
    } catch {
      embeddings = null
    }
  }

  if (chunks.length) {
    await prisma.knowledgeChunk.createMany({
      data: chunks.map((content, i) => ({
        documentId: doc.id,
        organizationId: params.organizationId,
        agentId: params.agentId,
        ordinal: i,
        content,
        embedding: embeddings ? embeddings[i] : undefined,
      })),
    })

    // Write the pgvector column too (deploy-window symmetry with the legacy
    // Json `embedding` above — the follow-up migration drops the Json column
    // once reads no longer need it). createMany doesn't return generated ids,
    // so re-fetch ordered by ordinal to line them back up with `embeddings`.
    if (embeddings) {
      const created = await prisma.knowledgeChunk.findMany({
        where: { documentId: doc.id, organizationId: params.organizationId },
        orderBy: { ordinal: 'asc' },
        select: { id: true },
      })
      const values = created.map((row, i) => Prisma.sql`(${row.id}::text, ${toSqlVector(embeddings![i])}::vector(1024))`)
      if (values.length) {
        // search_path guard: see retrieveKnowledge for the Supabase
        // extensions-schema note — SET LOCAL scopes it to this transaction.
        await tenantTransaction(params.organizationId, async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL search_path = public, extensions')
          await tx.$executeRaw`
            UPDATE "knowledge_chunks" AS c
            SET "embeddingVec" = v.vec
            FROM (VALUES ${Prisma.join(values)}) AS v(id, vec)
            WHERE c."id" = v.id AND c."organizationId" = ${params.organizationId}::uuid
          `
        })
      }
    }
  }
  return { id: doc.id, filename: doc.filename, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, charCount: doc.charCount, chunkCount: chunks.length, createdAt: doc.createdAt }
}
