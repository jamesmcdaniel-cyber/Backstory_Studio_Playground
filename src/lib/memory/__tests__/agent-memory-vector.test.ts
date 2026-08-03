import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  delete process.env.VOYAGE_API_KEY

  let prisma: any
  let retrieveAgentMemory: any
  let saveAgentMemory: any
  let vectorReady = false
  const ids: Record<string, string> = {}

  const dims = (fn: (i: number) => number) => Array.from({ length: 1024 }, (_, i) => fn(i))

  let origFetch: typeof fetch
  function stubEmbedding(vector: number[]) {
    origFetch = global.fetch
    process.env.VOYAGE_API_KEY = 'test-key'
    // @ts-expect-error test stub
    global.fetch = async () => ({ ok: true, json: async () => ({ data: [{ embedding: vector, index: 0 }] }) })
  }
  function unstubEmbedding() {
    global.fetch = origFetch
    delete process.env.VOYAGE_API_KEY
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ retrieveAgentMemory, saveAgentMemory } = await import('../agent-memory'))

    const available = await prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`
    vectorReady = Array.isArray(available) && available.length > 0
    if (!vectorReady) return

    const org = await prisma.organization.create({ data: { name: 'memory-vector Org', slug: `memory-vector-${Date.now()}` } })
    ids.org = org.id
    const otherOrg = await prisma.organization.create({ data: { name: 'memory-vector other Org', slug: `memory-vector-other-${Date.now()}` } })
    ids.otherOrg = otherOrg.id

    const agent = await prisma.agentTask.create({
      data: { organizationId: org.id, description: 'memory-vector test agent', objective: 'test' },
    })
    ids.agent = agent.id

    const otherAgent = await prisma.agentTask.create({
      data: { organizationId: otherOrg.id, description: 'other org agent', objective: 'test' },
    })
    ids.otherAgent = otherAgent.id
  })

  after(async () => {
    if (!vectorReady) return
    await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
    await prisma.organization.delete({ where: { id: ids.otherOrg } }).catch(() => {})
  })

  test('retrieveAgentMemory ranks in-database by cosine distance and respects status=open + org isolation', async () => {
    if (!vectorReady) return

    const near = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'near memory', content: 'near content', status: 'open' },
    })
    const far = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'far memory', content: 'far content', status: 'open' },
    })
    const dismissed = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'dismissed memory', content: 'dismissed content', status: 'dismissed' },
    })
    const otherOrgMemory = await prisma.agentMemory.create({
      data: { organizationId: ids.otherOrg, agentId: ids.otherAgent, kind: 'learning', title: 'other org memory', content: 'other org secret', status: 'open' },
    })

    await prisma.$executeRawUnsafe(`UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`, `[${dims((i) => (i === 0 ? 1 : 0.01)).join(',')}]`, near.id)
    await prisma.$executeRawUnsafe(`UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`, `[${dims((i) => (i === 0 ? -1 : 0)).join(',')}]`, far.id)
    await prisma.$executeRawUnsafe(`UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`, `[${dims((i) => (i === 0 ? 1 : 0.01)).join(',')}]`, dismissed.id)
    await prisma.$executeRawUnsafe(`UPDATE "agent_memories" SET "embeddingVec" = $1::vector(1024) WHERE "id" = $2`, `[${dims((i) => (i === 0 ? 1 : 0.01)).join(',')}]`, otherOrgMemory.id)

    stubEmbedding(dims((i) => (i === 0 ? 1 : 0.01)))
    try {
      const hits = await retrieveAgentMemory({ organizationId: ids.org, agentId: ids.agent, query: 'anything', k: 5 })
      assert.ok(hits.length > 0, 'expected hits')
      assert.equal(hits[0].id, near.id)
      const ids_ = hits.map((h: any) => h.id)
      assert.ok(!ids_.includes(dismissed.id), 'dismissed memory must not surface')
      assert.ok(!ids_.includes(otherOrgMemory.id), 'org isolation violated: another org memory surfaced')
    } finally {
      unstubEmbedding()
      await prisma.agentMemory.deleteMany({ where: { id: { in: [near.id, far.id, dismissed.id, otherOrgMemory.id] }, organizationId: { in: [ids.org, ids.otherOrg] } } }).catch(() => {})
    }
  })

  test('retrieveAgentMemory falls back to keyword scoring when embeddings are unconfigured', async () => {
    if (!vectorReady) return
    const row = await prisma.agentMemory.create({
      data: { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'keyword title', content: 'a very specific unique phrase', status: 'open' },
    })
    try {
      delete process.env.VOYAGE_API_KEY
      const hits = await retrieveAgentMemory({ organizationId: ids.org, agentId: ids.agent, query: 'a very specific unique phrase', k: 5 })
      assert.ok(hits.some((h: any) => h.id === row.id))
    } finally {
      await prisma.agentMemory.delete({ where: { id: row.id, organizationId: ids.org } }).catch(() => {})
    }
  })

  test('saveAgentMemory dedupes a near-identical suggestion embedding against the existing open row', async () => {
    if (!vectorReady) return
    const vector = dims((i) => (i === 0 ? 1 : 0.01))
    stubEmbedding(vector)
    let firstId: string | undefined
    try {
      const first = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'suggestion',
        title: 'Suggestion A',
        content: 'Consider doing X',
      })
      assert.ok(first)
      assert.equal(first!.deduped, false)
      firstId = first!.id

      const second = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'suggestion',
        title: 'Suggestion A (again)',
        content: 'Consider doing X',
      })
      assert.ok(second)
      assert.equal(second!.deduped, true)
      assert.equal(second!.id, firstId)

      const row = await prisma.agentMemory.findUnique({ where: { id: firstId, organizationId: ids.org } })
      assert.equal(row.timesUsed, 1)
    } finally {
      unstubEmbedding()
      if (firstId) await prisma.agentMemory.delete({ where: { id: firstId, organizationId: ids.org } }).catch(() => {})
    }
  })

  test('saveAgentMemory also writes the pgvector column alongside the legacy Json column', async () => {
    if (!vectorReady) return
    stubEmbedding(dims(() => 0.02))
    let id: string | undefined
    try {
      const saved = await saveAgentMemory({
        organizationId: ids.org,
        agentId: ids.agent,
        kind: 'learning',
        title: 'Vector write check',
        content: 'some learned fact',
      })
      assert.ok(saved)
      id = saved!.id
      const rows = await prisma.$queryRaw<Array<{ has_vec: boolean }>>`
        SELECT "embeddingVec" IS NOT NULL AS has_vec FROM "agent_memories" WHERE "id" = ${id}
      `
      assert.equal(rows[0]?.has_vec, true)
    } finally {
      unstubEmbedding()
      if (id) await prisma.agentMemory.delete({ where: { id, organizationId: ids.org } }).catch(() => {})
    }
  })

  test('saveAgentMemory threads a private agent\'s owner/visibility into the indexer', async () => {
    if (!vectorReady) return
    delete process.env.VOYAGE_API_KEY // no embedding path; exercise the indexer thread only
    const calls: any[] = []
    let id: string | undefined
    try {
      const saved = await saveAgentMemory(
        { organizationId: ids.org, agentId: ids.agent, kind: 'learning', title: 'Private fact', content: 'owned by repA', ownerUserId: 'repA', visibility: 'private' },
        { index: async (args: any) => { calls.push(args) } },
      )
      assert.ok(saved)
      id = saved!.id
      assert.equal(calls.length, 1, 'indexer should be called exactly once')
      assert.equal(calls[0].ownerUserId, 'repA')
      assert.equal(calls[0].visibility, 'private')
      assert.equal(calls[0].memoryId, id)
    } finally {
      if (id) await prisma.agentMemory.delete({ where: { id, organizationId: ids.org } }).catch(() => {})
    }
  })
}
