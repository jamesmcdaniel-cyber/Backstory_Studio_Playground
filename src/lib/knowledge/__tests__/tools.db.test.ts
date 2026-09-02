import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY

  let prisma: any
  let RepositoryToolClient: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ RepositoryToolClient } = await import('../tools'))
    const org = await prisma.organization.create({ data: { name: 'tools Org', slug: `tools-${Date.now()}` } })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { organizationId: org.id, supabaseId: randomUUID(), email: `tools-${Date.now()}@example.com`, name: 'Tools' },
    })
    ids.user = user.id
    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId: org.id,
        filename: 'journey.md',
        mimeType: 'text/markdown',
        status: 'ready',
        isEnabled: true,
        content: 'A'.repeat(10_000),
        charCount: 10_000,
      },
    })
    ids.document = doc.id
  })

  test('repository_read pages through a long document and terminates', async () => {
    const client = new RepositoryToolClient(ids.org, ids.user, null)
    const first: any = await client.executeTool('', 'repository_read', { documentId: ids.document })
    assert.equal(first.text.length, 8_000)
    assert.equal(first.offset, 0)
    assert.equal(first.nextOffset, 8_000)

    const second: any = await client.executeTool('', 'repository_read', { documentId: ids.document, offset: first.nextOffset })
    assert.equal(second.text.length, 2_000)
    assert.equal(second.nextOffset, null, 'the last window must report no continuation')
  })

  test('a limit beyond the maximum is clamped, not honoured', async () => {
    const client = new RepositoryToolClient(ids.org, ids.user, null)
    const page: any = await client.executeTool('', 'repository_read', { documentId: ids.document, limit: 999_999 })
    assert.ok(page.text.length <= 20_000)
  })

  test('a document in another workspace is not readable', async () => {
    const other = await prisma.organization.create({ data: { name: 'other', slug: `tools-other-${Date.now()}` } })
    const client = new RepositoryToolClient(other.id, ids.user, null)
    const result: any = await client.executeTool('', 'repository_read', { documentId: ids.document })
    assert.ok(result.error, 'cross-tenant read must not return content')
    assert.equal(result.text, undefined)
  })

  test('repository_list names documents with their searchability', async () => {
    const client = new RepositoryToolClient(ids.org, ids.user, null)
    const listing: any = await client.executeTool('', 'repository_list', {})
    const found = listing.documents.find((entry: any) => entry.documentId === ids.document)
    assert.ok(found)
    assert.equal(found.searchable, 'keyword only') // indexState defaulted to pending
  })
}
