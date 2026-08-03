import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let vectorReady = false
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))

    const available = await prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    vectorReady = Array.isArray(available) && available.length > 0
    if (!vectorReady) return

    const org = await prisma.organization.create({ data: { name: 'pgvector Org', slug: `pgvector-${Date.now()}` } })
    ids.org = org.id

    const document = await prisma.knowledgeDocument.create({
      data: { organizationId: org.id, filename: 'doc.txt', mimeType: 'text/plain' },
    })
    ids.document = document.id

    const agent = await prisma.agentTask.create({
      data: { organizationId: org.id, description: 'pgvector test agent', objective: 'test' },
    })
    ids.agent = agent.id
  })

  after(async () => {
    if (!vectorReady) return
    await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
  })

  test('inserting a chunk row then writing a 1024-dim vector round-trips', async () => {
    if (!vectorReady) return

    const chunk = await prisma.knowledgeChunk.create({
      data: { documentId: ids.document, organizationId: ids.org, content: 'hello world' },
    })

    const vec = `[${Array.from({ length: 1024 }, () => 0.1).join(', ')}]`
    await prisma.$executeRawUnsafe(
      `UPDATE "knowledge_chunks" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`,
      vec,
      chunk.id,
    )

    const rows = await prisma.$queryRaw<Array<{ has_vec: boolean }>>`
      SELECT "embeddingVec" IS NOT NULL AS has_vec FROM "knowledge_chunks" WHERE "id" = ${chunk.id}
    `
    assert.equal(rows[0]?.has_vec, true)

    await prisma.knowledgeChunk.delete({ where: { id: chunk.id, organizationId: ids.org } }).catch(() => {})
  })

  test('inserting an agent memory row then writing a 1024-dim vector round-trips', async () => {
    if (!vectorReady) return

    const memory = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'test', content: 'pgvector test' },
    })

    const vec = `[${Array.from({ length: 1024 }, () => 0.1).join(', ')}]`
    await prisma.$executeRawUnsafe(
      `UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`,
      vec,
      memory.id,
    )

    const rows = await prisma.$queryRaw<Array<{ has_vec: boolean }>>`
      SELECT "embeddingVec" IS NOT NULL AS has_vec FROM "agent_memories" WHERE "id" = ${memory.id}
    `
    assert.equal(rows[0]?.has_vec, true)

    await prisma.agentMemory.delete({ where: { id: memory.id, organizationId: ids.org } }).catch(() => {})
  })

  test('a <=> distance query orders synthetic vectors nearest-first', async () => {
    if (!vectorReady) return

    const near = await prisma.knowledgeChunk.create({
      data: { documentId: ids.document, organizationId: ids.org, content: 'near' },
    })
    const far = await prisma.knowledgeChunk.create({
      data: { documentId: ids.document, organizationId: ids.org, content: 'far' },
    })

    const query = `[${Array.from({ length: 1024 }, () => 1).join(', ')}]`
    const nearVec = `[${Array.from({ length: 1024 }, () => 0.99).join(', ')}]`
    const farVec = `[${Array.from({ length: 1024 }, (_, i) => (i === 0 ? -1 : 0)).join(', ')}]`

    await prisma.$executeRawUnsafe(
      `UPDATE "knowledge_chunks" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`,
      nearVec,
      near.id,
    )
    await prisma.$executeRawUnsafe(
      `UPDATE "knowledge_chunks" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`,
      farVec,
      far.id,
    )

    const ordered: Array<{ id: string }> = await prisma.$queryRawUnsafe(
      `SELECT "id" FROM "knowledge_chunks" WHERE "id" IN ($1, $2) ORDER BY "embeddingVec" <=> $3::vector(1024) ASC`,
      near.id,
      far.id,
      query,
    )

    assert.equal(ordered[0]?.id, near.id)
    assert.equal(ordered[1]?.id, far.id)

    await prisma.knowledgeChunk.deleteMany({ where: { id: { in: [near.id, far.id] }, organizationId: ids.org } }).catch(() => {})
  })

  test('writing a wrong-dimension vector fails loudly', async () => {
    if (!vectorReady) return

    const chunk = await prisma.knowledgeChunk.create({
      data: { documentId: ids.document, organizationId: ids.org, content: 'wrong dim' },
    })

    const badVec = `[${Array.from({ length: 3 }, () => 0.1).join(', ')}]`

    await assert.rejects(
      prisma.$executeRawUnsafe(
        `UPDATE "knowledge_chunks" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`,
        badVec,
        chunk.id,
      ),
      /dimension/i,
    )

    await prisma.knowledgeChunk.delete({ where: { id: chunk.id, organizationId: ids.org } }).catch(() => {})
  })
}
