import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY // keyword path; SCOPING is what is under test

  let prisma: any
  let retrieveKnowledge: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ retrieveKnowledge } = await import('../retrieve'))

    const org = await prisma.organization.create({ data: { name: 'coll Org', slug: `coll-${Date.now()}` } })
    const otherOrg = await prisma.organization.create({ data: { name: 'other', slug: `coll-other-${Date.now()}` } })
    ids.org = org.id
    ids.otherOrg = otherOrg.id
    const agent = await prisma.agentTask.create({
      data: { organizationId: org.id, description: 'collection agent', objective: 'test' },
    })
    ids.agent = agent.id
    const bystander = await prisma.agentTask.create({
      data: { organizationId: org.id, description: 'unattached agent', objective: 'test' },
    })
    ids.bystander = bystander.id

    const collection = await prisma.knowledgeCollection.create({
      data: { organizationId: org.id, name: 'Customer Journey' },
    })
    ids.collection = collection.id
    await prisma.agentKnowledgeCollection.create({
      data: { agentId: agent.id, collectionId: collection.id, organizationId: org.id },
    })

    const seed = async (orgId: string, agentId: string | null, filename: string, content: string) => {
      const doc = await prisma.knowledgeDocument.create({
        data: {
          organizationId: orgId, agentId, filename, mimeType: 'text/plain',
          status: 'ready', isEnabled: true, indexState: 'unindexed',
        },
      })
      await prisma.knowledgeChunk.create({
        data: { documentId: doc.id, organizationId: orgId, agentId, ordinal: 0, content },
      })
      return doc.id
    }

    // Reachable by `agent` ONLY through the collection: the document is bound
    // directly to a DIFFERENT agent, so neither the direct branch nor the
    // org-wide branch admits it — only the collection join chain can.
    ids.viaCollection = await seed(ids.org, ids.bystander, 'journey.md', 'renewal stage exit criteria documented')
    await prisma.knowledgeDocumentCollection.create({
      data: { documentId: ids.viaCollection, collectionId: collection.id, organizationId: org.id },
    })
    // Another org's document with identical text — must never appear.
    ids.foreign = await seed(ids.otherOrg, null, 'foreign.md', 'renewal stage exit criteria documented')
  })

  test('a document reaches an agent through its collection', async () => {
    const hits = await retrieveKnowledge({
      organizationId: ids.org,
      agentId: ids.agent,
      query: 'renewal stage exit criteria documented',
    })
    assert.ok(hits.some((hit: any) => hit.documentId === ids.viaCollection))
  })

  test('an agent with neither binding nor collection cannot reach it', async () => {
    const outsider = await prisma.agentTask.create({
      data: { organizationId: ids.org, description: 'outsider agent', objective: 'test' },
    })
    const hits = await retrieveKnowledge({
      organizationId: ids.org,
      agentId: outsider.id,
      query: 'renewal stage exit criteria documented',
    })
    assert.equal(hits.some((hit: any) => hit.documentId === ids.viaCollection), false)
  })

  test('another org is never reachable, identical text or not', async () => {
    const hits = await retrieveKnowledge({
      organizationId: ids.org,
      agentId: ids.agent,
      query: 'renewal stage exit criteria documented',
    })
    assert.equal(hits.some((hit: any) => hit.documentId === ids.foreign), false)
  })
}
