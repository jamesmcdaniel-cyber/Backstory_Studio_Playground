import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY

  let prisma: any
  let retrieveKnowledge: any
  let vectorReady = false
  const ids: Record<string, string> = {}

  const dims = (fn: (i: number) => number) => `[${Array.from({ length: 1024 }, (_, i) => fn(i)).join(',')}]`

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ retrieveKnowledge } = await import('../retrieve'))

    const available = await prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    vectorReady = Array.isArray(available) && available.length > 0
    if (!vectorReady) return

    const org = await prisma.organization.create({ data: { name: 'retrieve-vector Org', slug: `retrieve-vector-${Date.now()}` } })
    ids.org = org.id
    const otherOrg = await prisma.organization.create({ data: { name: 'other Org', slug: `retrieve-vector-other-${Date.now()}` } })
    ids.otherOrg = otherOrg.id

    const agent = await prisma.agentTask.create({
      data: { organizationId: org.id, description: 'retrieve-vector test agent', objective: 'test' },
    })
    ids.agent = agent.id

    const doc = await prisma.knowledgeDocument.create({
      data: { organizationId: org.id, agentId: agent.id, filename: 'doc.txt', mimeType: 'text/plain' },
    })
    ids.document = doc.id

    const otherDoc = await prisma.knowledgeDocument.create({
      data: { organizationId: otherOrg.id, filename: 'other-doc.txt', mimeType: 'text/plain' },
    })
    ids.otherDocument = otherDoc.id

    // Chunk A: far from the query vector (opposite direction on dim 0).
    const chunkA = await prisma.knowledgeChunk.create({
      data: { documentId: doc.id, organizationId: org.id, agentId: agent.id, ordinal: 0, content: 'chunk A content' },
    })
    // Chunk B: nearest to the query vector.
    const chunkB = await prisma.knowledgeChunk.create({
      data: { documentId: doc.id, organizationId: org.id, agentId: agent.id, ordinal: 1, content: 'chunk B content' },
    })
    // Chunk C: org-wide (agentId null), moderately close.
    const chunkC = await prisma.knowledgeChunk.create({
      data: { documentId: doc.id, organizationId: org.id, agentId: null, ordinal: 2, content: 'chunk C content' },
    })
    ids.chunkA = chunkA.id
    ids.chunkB = chunkB.id
    ids.chunkC = chunkC.id

    await prisma.$executeRawUnsafe(
      `UPDATE "knowledge_chunks" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`,
      dims((i) => (i === 0 ? -1 : 0)),
      chunkA.id,
    )
    await prisma.$executeRawUnsafe(
      `UPDATE "knowledge_chunks" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`,
      dims((i) => (i === 0 ? 1 : 0.01)),
      chunkB.id,
    )
    await prisma.$executeRawUnsafe(
      `UPDATE "knowledge_chunks" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`,
      dims((i) => (i === 0 ? 0.5 : 0.02)),
      chunkC.id,
    )

    // Another org's chunk, embedded to be maximally close to the query — must NEVER surface.
    const otherChunk = await prisma.knowledgeChunk.create({
      data: { documentId: otherDoc.id, organizationId: otherOrg.id, ordinal: 0, content: 'other org secret content' },
    })
    ids.otherChunk = otherChunk.id
    await prisma.$executeRawUnsafe(
      `UPDATE "knowledge_chunks" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`,
      dims((i) => (i === 0 ? 1 : 0)),
      otherChunk.id,
    )
  })

  after(async () => {
    if (!vectorReady) return
    await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
    await prisma.organization.delete({ where: { id: ids.otherOrg } }).catch(() => {})
  })

  test('retrieveKnowledge ranks in-database by cosine distance, nearest first', async () => {
    if (!vectorReady) return
    const { embedQuery } = await import('@/lib/rag/embeddings')
    void embedQuery // unused when embeddings unconfigured; keeping import symmetric with prod code

    // Directly exercise the vector path by stubbing embeddingsConfigured via env.
    process.env.VOYAGE_API_KEY = 'test-key'
    const origFetch = global.fetch
    // @ts-expect-error test stub
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: JSON.parse(dims((i) => (i === 0 ? 1 : 0.01))), index: 0 }] }),
    })
    try {
      const hits = await retrieveKnowledge({ organizationId: ids.org, agentId: ids.agent, query: 'anything', k: 5 })
      assert.ok(hits.length > 0, 'expected hits')
      assert.equal(hits[0].content, 'chunk B content')
      assert.ok(hits[0].score > 0.9, `expected near-1 score, got ${hits[0].score}`)
      const contents = hits.map((h: any) => h.content)
      assert.ok(!contents.includes('other org secret content'), 'org isolation violated')
    } finally {
      global.fetch = origFetch
      delete process.env.VOYAGE_API_KEY
    }
  })

  test('retrieveKnowledge never returns another org\'s chunks even when nearest', async () => {
    if (!vectorReady) return
    process.env.VOYAGE_API_KEY = 'test-key'
    const origFetch = global.fetch
    // @ts-expect-error test stub
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: JSON.parse(dims((i) => (i === 0 ? 1 : 0))), index: 0 }] }),
    })
    try {
      const hits = await retrieveKnowledge({ organizationId: ids.org, agentId: ids.agent, query: 'anything', k: 10 })
      const contents = hits.map((h: any) => h.content)
      assert.ok(!contents.includes('other org secret content'), 'org isolation violated: another org chunk surfaced')
    } finally {
      global.fetch = origFetch
      delete process.env.VOYAGE_API_KEY
    }
  })

  test('vector retrieval excludes a disabled repository document', async () => {
    if (!vectorReady) return
    await prisma.knowledgeDocument.update({
      where: { id: ids.document, organizationId: ids.org },
      data: { isEnabled: false },
    })
    process.env.VOYAGE_API_KEY = 'test-key'
    const origFetch = global.fetch
    // @ts-expect-error test stub
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ embedding: JSON.parse(dims((i) => (i === 0 ? 1 : 0))), index: 0 }] }),
    })
    try {
      const hits = await retrieveKnowledge({ organizationId: ids.org, agentId: ids.agent, query: 'anything', k: 10 })
      assert.ok(!hits.some((hit: any) => hit.documentId === ids.document), 'disabled repository content surfaced')
    } finally {
      global.fetch = origFetch
      delete process.env.VOYAGE_API_KEY
      await prisma.knowledgeDocument.update({
        where: { id: ids.document, organizationId: ids.org },
        data: { isEnabled: true },
      })
    }
  })

  test('retrieveKnowledge falls back to keyword scoring when embeddings are unconfigured', async () => {
    if (!vectorReady) return
    delete process.env.VOYAGE_API_KEY
    const hits = await retrieveKnowledge({ organizationId: ids.org, agentId: ids.agent, query: 'chunk B content', k: 5 })
    assert.ok(hits.length > 0, 'expected keyword-fallback hits')
    assert.ok(hits.some((h: any) => h.content === 'chunk B content'))
  })
}
