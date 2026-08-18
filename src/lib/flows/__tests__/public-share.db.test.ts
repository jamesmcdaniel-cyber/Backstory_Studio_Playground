import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

// DB-backed: the anonymous share-link resolver's access contract.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let resolveAnonymousFlowShare: any
  let hashToken: any

  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'call', type: 'http', data: { label: 'Fetch', method: 'GET', url: 'https://api.example.com/x?key=SECRET' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
  }

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ resolveAnonymousFlowShare } = await import('@/lib/flows/public-share'))
    ;({ hashToken } = await import('@/lib/crypto/secrets'))
    const { seedTestOrg } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
  })

  after(async () => {
    if (seeded) await seeded.cleanup()
  })

  /**
   * Seeds a flow the way minting does: the row carries only the DIGEST, and the
   * raw token stays in the test's hand — exactly the split the resolver must
   * bridge on every lookup.
   */
  const mkFlow = ({ shareToken, ...data }: Record<string, unknown> & { shareToken?: string }) =>
    prisma.flow.create({
      data: {
        organizationId: seeded.organizationId,
        userId: seeded.userId,
        name: 'Public flow',
        graph,
        ...(shareToken ? { shareTokenDigest: hashToken(shareToken) } : {}),
        ...data,
      },
    })

  test('a token is only resolvable when the owner opted in — and never leaks the graph payload', async () => {
    // Opted OUT: a valid token alone is not enough.
    const optedOut = await mkFlow({ shareToken: 'tok-opted-out-000000', shareAnonymous: false })
    assert.equal((await resolveAnonymousFlowShare('tok-opted-out-000000', { clientKey: 'a' })).status, 'not_found')

    // Opted IN: resolves, and the payload is the sanitized projection.
    const shared = await mkFlow({ shareToken: 'tok-opted-in-0000000', shareAnonymous: true, description: 'A shared pipeline' })
    assert.equal(shared.shareTokenDigest, hashToken('tok-opted-in-0000000'))
    assert.equal(
      JSON.stringify(shared).includes('tok-opted-in-0000000'),
      false,
      'the stored row holds no plaintext token',
    )
    const result = await resolveAnonymousFlowShare('tok-opted-in-0000000', { clientKey: 'b' })
    assert.equal(result.status, 'ok', 'lookup succeeds by hashing what the visitor presented')
    assert.equal(result.flow.name, 'Public flow')
    assert.equal(result.flow.description, 'A shared pipeline')
    const serialized = JSON.stringify(result.flow.graph)
    assert.ok(!serialized.includes('SECRET'), 'the query string must not reach an anonymous viewer')
    assert.ok(serialized.includes('Fetch'), 'author copy still renders')

    // Unknown / too-short tokens are refused without a DB round trip.
    assert.equal((await resolveAnonymousFlowShare('nope-nope-nope-nope0', { clientKey: 'c' })).status, 'not_found')
    assert.equal((await resolveAnonymousFlowShare('', { clientKey: 'c' })).status, 'not_found')

    await prisma.flow.deleteMany({ where: { id: { in: [optedOut.id, shared.id] }, organizationId: seeded.organizationId } })
  })

  test('each anonymous open increments the owner-visible counter', async () => {
    const flow = await mkFlow({ shareToken: 'tok-counted-0000000', shareAnonymous: true })
    await resolveAnonymousFlowShare('tok-counted-0000000', { clientKey: 'count-1' })
    await resolveAnonymousFlowShare('tok-counted-0000000', { clientKey: 'count-2' })
    const after = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: seeded.organizationId } })
    assert.equal(after.anonymousViews, 2)
    // countView:false is the explicit opt-out (used by anything that resolves
    // a link without a human actually looking at it).
    await resolveAnonymousFlowShare('tok-counted-0000000', { clientKey: 'count-3', countView: false })
    const unchanged = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: seeded.organizationId } })
    assert.equal(unchanged.anonymousViews, 2)
    await prisma.flow.deleteMany({ where: { id: flow.id, organizationId: seeded.organizationId } })
  })

  test('the published graph is preferred over the working draft', async () => {
    const publishedGraph = {
      nodes: [{ id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } }, { id: 'p', type: 'output', data: { label: 'Published step', outputs: [] } }],
      edges: [{ id: 'e0', source: 'trigger', target: 'p' }],
    }
    const flow = await mkFlow({ shareToken: 'tok-published-000000', shareAnonymous: true, publishedGraph })
    const result = await resolveAnonymousFlowShare('tok-published-000000', { clientKey: 'pub' })
    assert.equal(result.status, 'ok')
    const serialized = JSON.stringify(result.flow.graph)
    assert.ok(serialized.includes('Published step'), 'shows what is published')
    assert.ok(!serialized.includes('Fetch'), 'not the owner’s in-progress draft')
    await prisma.flow.deleteMany({ where: { id: flow.id, organizationId: seeded.organizationId } })
  })

  test('repeated lookups from one client are rate limited', async () => {
    const flow = await mkFlow({ shareToken: 'tok-ratelimit-00000', shareAnonymous: true })
    let limited = false
    for (let i = 0; i < 40; i++) {
      const result = await resolveAnonymousFlowShare('tok-ratelimit-00000', { clientKey: 'flooder', countView: false })
      if (result.status === 'rate_limited') {
        limited = true
        break
      }
    }
    assert.ok(limited, 'a flood of opens from one client is eventually refused')
    await prisma.flow.deleteMany({ where: { id: flow.id, organizationId: seeded.organizationId } })
  })
}
