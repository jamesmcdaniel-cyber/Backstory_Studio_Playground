import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY // no provider: every chunk lands without a vector

  let prisma: any
  let ingestKnowledgeFile: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ ingestKnowledgeFile } = await import('../ingest'))
    const org = await prisma.organization.create({
      data: { name: 'ingest-state Org', slug: `ingest-state-${Date.now()}` },
    })
    ids.org = org.id
  })

  test('a document ingested with no embedding provider is marked unindexed, not ready-and-silent', async () => {
    const doc = await ingestKnowledgeFile({
      organizationId: ids.org,
      agentId: null,
      userId: null,
      filename: 'journey.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Stage one is discovery. Stage two is validation.'),
    })
    const row = await prisma.knowledgeDocument.findFirst({ where: { id: doc.id, organizationId: ids.org } })
    assert.equal(row.status, 'ready')
    assert.equal(row.indexState, 'unindexed')
    assert.equal(row.truncated, false)
    assert.match(row.indexError, /embedding provider/i)
  })

  test('extraction beyond the character cap sets truncated', async () => {
    const doc = await ingestKnowledgeFile({
      organizationId: ids.org,
      agentId: null,
      userId: null,
      filename: 'huge.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('word '.repeat(60_000)), // 300k chars > KNOWLEDGE_MAX_CHARS
    })
    const row = await prisma.knowledgeDocument.findFirst({ where: { id: doc.id, organizationId: ids.org } })
    assert.equal(row.truncated, true)
    assert.ok(row.charCount <= 200_000)
  })
}
