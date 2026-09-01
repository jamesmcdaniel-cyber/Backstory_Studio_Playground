import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  // The QUERY embeds fine; the DOCUMENT has no vectors. That asymmetry is the
  // whole point — the old code took the vector path, which excludes NULL-vector
  // chunks, and never ran the keyword path because the query itself was fine.
  process.env.VOYAGE_API_KEY = 'test-key'

  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes('voyageai.com')) {
      const body = JSON.parse(init.body)
      const count = Array.isArray(body.input) ? body.input.length : 1
      return new Response(
        JSON.stringify({
          data: Array.from({ length: count }, (_, index) => ({
            embedding: Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
            index,
          })),
          usage: { total_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return realFetch(url, init)
  }) as typeof fetch

  let prisma: any
  let retrieveKnowledge: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ retrieveKnowledge } = await import('../retrieve'))
    const org = await prisma.organization.create({
      data: { name: 'fallback Org', slug: `fallback-${Date.now()}` },
    })
    ids.org = org.id
    const agent = await prisma.agentTask.create({
      data: { organizationId: org.id, description: 'fallback agent', objective: 'test' },
    })
    ids.agent = agent.id
    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId: org.id,
        agentId: agent.id,
        filename: 'journey.md',
        mimeType: 'text/markdown',
        status: 'ready',
        isEnabled: true,
        indexState: 'unindexed', // the whole point: no vectors at all
      },
    })
    ids.document = doc.id
    await prisma.knowledgeChunk.create({
      data: {
        documentId: doc.id,
        organizationId: org.id,
        agentId: agent.id,
        ordinal: 0,
        content: 'The renewal stage requires a documented success plan and an executive sponsor.',
      },
    })
  })

  test('an unindexed document is still reachable by keyword rather than invisible', async () => {
    const hits = await retrieveKnowledge({
      organizationId: ids.org,
      agentId: ids.agent,
      query: 'renewal stage executive sponsor',
    })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].documentId, ids.document)
    assert.equal(hits[0].matchedBy, 'keyword')
  })
}
