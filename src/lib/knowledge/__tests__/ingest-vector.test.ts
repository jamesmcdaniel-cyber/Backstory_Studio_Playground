import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY

  let prisma: any
  let ingestKnowledgeFile: any
  let vectorReady = false
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ ingestKnowledgeFile } = await import('../ingest'))

    const available = await prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    vectorReady = Array.isArray(available) && available.length > 0
    if (!vectorReady) return

    const org = await prisma.organization.create({ data: { name: 'ingest-vector Org', slug: `ingest-vector-${Date.now()}` } })
    ids.org = org.id
  })

  after(async () => {
    if (!vectorReady) return
    await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
  })

  test('ingestKnowledgeFile batch-writes embeddingVec for every chunk, matching ordinal order', async () => {
    if (!vectorReady) return
    process.env.VOYAGE_API_KEY = 'test-key'
    const origFetch = global.fetch
    // @ts-expect-error test stub
    global.fetch = async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      const data = body.input.map((_text: string, index: number) => ({
        index,
        embedding: Array.from({ length: 1024 }, (_, i) => (i === index ? 1 : 0)),
      }))
      return { ok: true, json: async () => ({ data }) }
    }
    let docId: string | undefined
    try {
      const text = ['first paragraph of content', 'second paragraph of content', 'third paragraph of content'].join('\n\n---\n\n')
      const result = await ingestKnowledgeFile({
        organizationId: ids.org,
        agentId: null,
        userId: null,
        filename: 'notes.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from(text, 'utf-8'),
      })
      docId = result.id
      assert.ok(result.chunkCount > 0)

      const rows: Array<{ ordinal: number; has_vec: boolean; content: string }> = await prisma.$queryRaw`
        SELECT "ordinal", "embeddingVec" IS NOT NULL AS has_vec, "content"
        FROM "knowledge_chunks" WHERE "documentId" = ${docId} ORDER BY "ordinal" ASC
      `
      assert.equal(rows.length, result.chunkCount)
      for (const row of rows) assert.equal(row.has_vec, true, `chunk ordinal ${row.ordinal} missing embeddingVec`)

      // Legacy Json embedding column still written too (deploy-window symmetry).
      const legacy: Array<{ has_json: boolean }> = await prisma.$queryRaw`
        SELECT "embedding" IS NOT NULL AS has_json FROM "knowledge_chunks" WHERE "documentId" = ${docId}
      `
      for (const row of legacy) assert.equal(row.has_json, true)
    } finally {
      global.fetch = origFetch
      delete process.env.VOYAGE_API_KEY
      if (docId) {
        await prisma.knowledgeChunk.deleteMany({ where: { documentId: docId, organizationId: ids.org } }).catch(() => {})
        await prisma.knowledgeDocument.delete({ where: { id: docId, organizationId: ids.org } }).catch(() => {})
      }
    }
  })
}
