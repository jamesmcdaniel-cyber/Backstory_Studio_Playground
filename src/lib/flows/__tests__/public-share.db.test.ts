import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// DB-backed: the public flow link's access contract — resolve, expiry,
// rotation, the anonymous API route, and "Use this flow" copies.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'ci-encryption-key'
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seeded: any
  let visitor: any
  let lib: typeof import('@/lib/flows/public-share')
  let installTestAuth: any

  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: { trigger: { type: 'manual' } } },
      { id: 'call', type: 'http', data: { label: 'Fetch', method: 'GET', url: 'https://api.example.com/x?key=SECRET', credentialId: 'cred_owner' } },
    ],
    edges: [{ id: 'e0', source: 'trigger', target: 'call' }],
    pinData: { call: { rows: ['private sample'] } },
  }
  const origin = 'https://app.example.com'
  const tokenOf = (url: string | null) => (url ?? '').split('/share/flow/')[1] ?? ''

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    lib = await import('@/lib/flows/public-share')
    const auth = await import('@/lib/server/__tests__/test-auth')
    installTestAuth = auth.installTestAuth
    seeded = await auth.seedTestOrg(prisma)
    visitor = await auth.seedTestOrg(prisma)
  })

  after(async () => {
    for (const org of [seeded, visitor]) if (org) await org.cleanup()
  })

  const mkFlow = (data: Record<string, unknown> = {}) =>
    prisma.flow.create({ data: { organizationId: seeded.organizationId, userId: seeded.userId, name: 'Public flow', description: 'A shared pipeline', graph, ...data } })
  const enable = (flowId: string, patch: Record<string, unknown> = { action: 'enable' }) =>
    lib.updatePublicLink(seeded.organizationId, flowId, seeded.userId, origin, patch as never)

  test('off until opted in; on, it resolves to the sanitized view by a 192-bit token kept as digest + ciphertext', async () => {
    const flow = await mkFlow()
    const state = await lib.loadPublicLink(seeded.organizationId, flow.id, seeded.userId, origin)
    assert.equal(state.enabled, false)
    const on = await enable(flow.id)
    const token = tokenOf(on.url)
    assert.equal(Buffer.from(token, 'base64url').length, 24, '192-bit token')
    const row = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: seeded.organizationId } })
    assert.equal(JSON.stringify(row).includes(token), false, 'no plaintext at rest')
    assert.ok(row.publicTokenDigest && row.publicTokenCiphertext)
    assert.equal(row.shareTokenDigest, null, 'the public link never mints a jam (collaborator) token')
    // An editor can copy the same link again after a reload.
    assert.equal((await lib.loadPublicLink(seeded.organizationId, flow.id, seeded.userId, origin)).url, on.url)

    const result = await lib.resolveAnonymousFlowShare(token, { clientKey: 'pub-1' })
    assert.equal(result.status, 'ok')
    if (result.status !== 'ok') return
    assert.equal(result.flow.name, 'Public flow')
    const serialized = JSON.stringify(result.flow)
    for (const leak of ['SECRET', 'cred_owner', 'private sample', seeded.organizationId]) assert.ok(!serialized.includes(leak), `${leak} leaked`)
    assert.ok(serialized.includes('Fetch'), 'author copy still renders')
    assert.equal((await lib.resolveAnonymousFlowShare('x'.repeat(32), { clientKey: 'pub-1' })).status, 'not_found')
  })

  test('rotation kills the old URL and resets the count; expiry and disable end access', async () => {
    const flow = await mkFlow()
    const first = tokenOf((await enable(flow.id)).url)
    await lib.resolveAnonymousFlowShare(first, { clientKey: 'rot-1' })
    const rotated = await enable(flow.id, { action: 'rotate' })
    assert.equal(rotated.views, 0)
    const second = tokenOf(rotated.url)
    assert.notEqual(first, second)
    assert.equal((await lib.resolveAnonymousFlowShare(first, { clientKey: 'rot-2' })).status, 'not_found')
    assert.equal((await lib.resolveAnonymousFlowShare(second, { clientKey: 'rot-2' })).status, 'ok')

    await assert.rejects(enable(flow.id, { expiresAt: new Date(Date.now() - 1000).toISOString() }), /future/)
    const expiring = await enable(flow.id, { expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    assert.ok(expiring.expiresAt)
    await prisma.flow.updateMany({ where: { id: flow.id, organizationId: seeded.organizationId }, data: { publicExpiresAt: new Date(Date.now() - 1000) } })
    assert.equal((await lib.resolveAnonymousFlowShare(second, { clientKey: 'rot-3' })).status, 'expired')

    const off = await enable(flow.id, { action: 'disable' })
    assert.equal(off.enabled, false)
    assert.equal((await lib.resolveAnonymousFlowShare(second, { clientKey: 'rot-4' })).status, 'not_found')
    const audits = await prisma.auditEvent.findMany({ where: { organizationId: seeded.organizationId, resourceId: flow.id, action: { startsWith: 'flow.public_link' } } })
    assert.deepEqual(new Set(audits.map((a: any) => a.action)), new Set(['flow.public_link_enabled', 'flow.public_link_rotated', 'flow.public_link_changed', 'flow.public_link_disabled']))
  })

  test('the anonymous API route serves only the allowlisted payload', async () => {
    const flow = await mkFlow()
    const token = tokenOf((await enable(flow.id)).url)
    const { GET } = await import('@/app/api/share/flows/[token]/route')
    const res = await GET(new NextRequest(new URL(`http://test/api/share/flows/${token}`), { headers: { 'x-forwarded-for': '203.0.113.9' } }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(Object.keys(body.flow).sort(), [...lib.PUBLIC_FLOW_VIEW_FIELDS].sort())
    assert.equal((await GET(new NextRequest(new URL('http://test/api/share/flows/not-a-real-token-000000')))).status, 404)
  })

  test('"Use this flow": offered only on opt-in, refused while a literal credential is in the graph, copies never link back', async () => {
    const flow = await mkFlow()
    const token = tokenOf((await enable(flow.id)).url)
    const caller = { organizationId: visitor.organizationId, userId: visitor.userId }
    assert.equal((await lib.copyPublicFlow(token, caller)).status, 'not_offered')
    await enable(flow.id, { allowCopy: true })

    const copied = await lib.copyPublicFlow(token, caller)
    assert.equal(copied.status, 'ok')
    if (copied.status !== 'ok') return
    const copy = await prisma.flow.findFirst({ where: { id: copied.flowId, organizationId: visitor.organizationId } })
    assert.equal(copy.userId, visitor.userId)
    assert.equal(copy.visibility, 'private')
    assert.equal(copy.status, 'DRAFT')
    assert.equal(copy.shareAnonymous, false)
    const serialized = JSON.stringify(copy.graph)
    assert.ok(!serialized.includes('cred_owner') && !serialized.includes('private sample'), 'owner ids and pinned data stay home')
    assert.ok(serialized.includes('https://api.example.com/x'), 'the working steps come along')
    // Editing the copy never touches the original.
    await prisma.flow.update({ where: { id: copy.id, organizationId: visitor.organizationId }, data: { name: 'Mine now' } })
    const original = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: seeded.organizationId } })
    assert.equal(original.name, 'Public flow')

    // A credential typed in after copying was offered blocks the next copy.
    const leaky = { ...graph, nodes: [graph.nodes[0], { ...graph.nodes[1], data: { ...graph.nodes[1].data, headers: '{"Authorization":"Bearer sk-live-ABCDEFGHIJKLMNOP"}' } }] }
    await prisma.flow.update({ where: { id: flow.id, organizationId: seeded.organizationId }, data: { graph: leaky } })
    assert.equal((await lib.copyPublicFlow(token, caller)).status, 'blocked')
    await assert.rejects(enable(flow.id, { allowCopy: true }), /credential/)

    // Through the route, as the visitor.
    await prisma.flow.update({ where: { id: flow.id, organizationId: seeded.organizationId }, data: { graph } })
    installTestAuth(visitor.auth)
    const { POST } = await import('@/app/api/share/flows/[token]/copy/route')
    const res = await POST(new NextRequest(new URL(`http://test/api/share/flows/${token}/copy`), { method: 'POST' }))
    assert.equal(res.status, 200)
    assert.ok((await res.json()).flowId)
  })

  test('only a same-org editor can manage the link', async () => {
    const flow = await mkFlow({ visibility: 'view' })
    const member = await prisma.user.create({ data: { supabaseId: crypto.randomUUID(), organizationId: seeded.organizationId } })
    await assert.rejects(lib.updatePublicLink(seeded.organizationId, flow.id, member.id, origin, { action: 'enable' }), /view-only/)
    await assert.rejects(lib.updatePublicLink(visitor.organizationId, flow.id, visitor.userId, origin, { action: 'enable' }), /not found/i)
    await prisma.user.delete({ where: { id: member.id } })
  })

  test('repeated lookups from one client are rate limited', async () => {
    const flow = await mkFlow()
    const token = tokenOf((await enable(flow.id)).url)
    let limited = false
    for (let i = 0; i < 40; i++) {
      if ((await lib.resolveAnonymousFlowShare(token, { clientKey: 'flooder', countView: false })).status === 'rate_limited') {
        limited = true
        break
      }
    }
    assert.ok(limited, 'a flood of opens from one client is eventually refused')
  })
}
