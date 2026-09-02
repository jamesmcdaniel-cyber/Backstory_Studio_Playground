import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let svc: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    svc = await import('../collections')
    const org = await prisma.organization.create({ data: { name: 'svc Org', slug: `svc-${Date.now()}` } })
    ids.org = org.id
    const doc = await prisma.knowledgeDocument.create({
      data: { organizationId: org.id, filename: 'a.md', mimeType: 'text/markdown' },
    })
    ids.document = doc.id
  })

  test('a collection is created and counted', async () => {
    const created = await svc.createCollection({ organizationId: ids.org, name: 'Customer Journey', description: 'Stage map' })
    ids.collection = created.id
    const list = await svc.listCollections({ organizationId: ids.org })
    const found = list.find((c: any) => c.id === created.id)
    assert.equal(found.name, 'Customer Journey')
    assert.equal(found.documentCount, 0)
  })

  test("setting a document's collections is idempotent and drops foreign ids", async () => {
    const otherOrg = await prisma.organization.create({ data: { name: 'x', slug: `svc-x-${Date.now()}` } })
    const foreign = await prisma.knowledgeCollection.create({ data: { organizationId: otherOrg.id, name: 'Theirs' } })
    await svc.setDocumentCollections({ organizationId: ids.org, documentId: ids.document, collectionIds: [ids.collection, foreign.id] })
    await svc.setDocumentCollections({ organizationId: ids.org, documentId: ids.document, collectionIds: [ids.collection, foreign.id] })
    const joins = await prisma.knowledgeDocumentCollection.findMany({ where: { documentId: ids.document, organizationId: ids.org } })
    assert.deepEqual(joins.map((j: any) => j.collectionId), [ids.collection], "another org's collection must never be attachable")
  })

  test('renaming keeps counts and rejects an unknown id', async () => {
    const renamed = await svc.renameCollection({ organizationId: ids.org, id: ids.collection, name: 'Journey v2' })
    assert.equal(renamed.name, 'Journey v2')
    await assert.rejects(svc.renameCollection({ organizationId: ids.org, id: 'nope', name: 'x' }))
  })

  test('deleting a collection leaves its documents alone', async () => {
    await svc.deleteCollection({ organizationId: ids.org, id: ids.collection })
    const doc = await prisma.knowledgeDocument.findFirst({ where: { id: ids.document, organizationId: ids.org } })
    assert.ok(doc, 'the document must survive its collection')
    const joins = await prisma.knowledgeDocumentCollection.count({ where: { documentId: ids.document, organizationId: ids.org } })
    assert.equal(joins, 0)
  })
}
