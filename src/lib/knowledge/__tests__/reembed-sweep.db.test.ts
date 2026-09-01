import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.VOYAGE_API_KEY = 'test-key'

  let prisma: any
  let runReembedSweep: any
  const ids: Record<string, string> = {}
  let vectorReady = false

  // Stub the provider: one 1024-dim vector per input, no network.
  const fetchImpl = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body)
    const count = Array.isArray(body.input) ? body.input.length : 1
    return new Response(
      JSON.stringify({
        data: Array.from({ length: count }, (_, index) => ({
          embedding: Array.from({ length: 1024 }, () => 0.01),
          index,
        })),
        usage: { total_tokens: count },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as unknown as typeof fetch

  /** Drain the sweep to completion, bounded so a bug cannot spin forever. */
  const drain = async (max = 50) => {
    let passes = 0
    let last: any = null
    for (; passes < max; passes += 1) {
      last = await runReembedSweep({ fetchImpl })
      if (last.scanned === 0) break
    }
    return { passes, last }
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ runReembedSweep } = await import('../reembed-sweep'))
    const available = await prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    vectorReady = Array.isArray(available) && available.length > 0
    if (!vectorReady) return
    const org = await prisma.organization.create({
      data: { name: 'sweep Org', slug: `sweep-${Date.now()}` },
    })
    ids.org = org.id
    const doc = await prisma.knowledgeDocument.create({
      data: {
        organizationId: org.id,
        filename: 'journey.md',
        mimeType: 'text/markdown',
        status: 'ready',
        indexState: 'unindexed',
      },
    })
    ids.document = doc.id
    await prisma.knowledgeChunk.create({
      data: { documentId: doc.id, organizationId: org.id, ordinal: 0, content: 'Renewal stage exit criteria.' },
    })
  })

  test('the sweep fills NULL vectors and promotes the document to indexed', async (t) => {
    if (!vectorReady) return t.skip('pgvector not installed')
    const { last } = await drain()
    assert.ok(last, 'the sweep must report a result')
    const row = await prisma.knowledgeDocument.findFirst({
      where: { id: ids.document, organizationId: ids.org },
    })
    assert.equal(row.indexState, 'indexed')
    assert.equal(row.indexError, null, 'a healed document must stop reporting an error')
  })

  test('a drained sweep finds nothing left to do, and is safe to re-run', async (t) => {
    if (!vectorReady) return t.skip('pgvector not installed')
    const result = await runReembedSweep({ fetchImpl })
    assert.equal(result.scanned, 0)
    assert.equal(result.skippedNoProvider, false)
  })
}
