import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

// DB-gated: runs only under TEST_DATABASE_URL (CI-mode), like sibling DB tests.
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let shareRoute: any
  let flowRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    shareRoute = await import('../[id]/share/route')
    flowRoute = await import('../[id]/route')
  })

  const share = (flowId: string, body: Record<string, unknown>) =>
    shareRoute.POST(new NextRequest(new URL(`http://test/api/flows/${flowId}/share`), { method: 'POST', body: JSON.stringify(body) }))
  const open = (flowId: string, token?: string | null) =>
    flowRoute.GET(new NextRequest(new URL(`http://test/api/flows/${flowId}${token ? `?share=${token}` : ''}`)))
  const mkFlow = (organizationId: string, userId: string) =>
    prisma.flow.create({ data: { organizationId, userId, name: 'Shared flow', graph: { nodes: [], edges: [] } } })

  test('share lifecycle: mint → role change keeps the link → rotate mints fresh → disable clears', async () => {
    const s = await seedTestOrg(prisma)
    const { hashToken } = await import('@/lib/crypto/secrets')
    try {
      installTestAuth(s.auth)
      const flow = await mkFlow(s.organizationId, s.userId)
      const minted = await (await share(flow.id, { enabled: true, role: 'edit' })).json()
      assert.ok(minted.shareToken, 'mint returns a raw token')
      assert.equal(minted.shareEnabled, true)
      assert.equal(minted.shareRole, 'edit')

      // The row holds the DIGEST and nothing else — no plaintext at rest.
      const stored = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: s.organizationId } })
      assert.equal(stored.shareTokenDigest, hashToken(minted.shareToken))
      assert.equal(
        JSON.stringify(stored).includes(minted.shareToken),
        false,
        'the raw token appears nowhere on the stored row',
      )

      // A role change keeps the link working, but there is no plaintext left to
      // return — the token was shown once, at mint.
      const roleChanged = await (await share(flow.id, { enabled: true, role: 'view' })).json()
      assert.equal(roleChanged.shareToken, null, 'the raw token is never re-issued')
      assert.equal(roleChanged.shareEnabled, true)
      assert.equal(roleChanged.shareRole, 'view')
      const unchanged = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: s.organizationId } })
      assert.equal(unchanged.shareTokenDigest, stored.shareTokenDigest, 'sent links stay valid')

      const rotated = await (await share(flow.id, { enabled: true, role: 'view', rotate: true })).json()
      assert.ok(rotated.shareToken && rotated.shareToken !== minted.shareToken, 'rotate mints a fresh token')
      const afterRotate = await prisma.flow.findFirst({ where: { id: flow.id, organizationId: s.organizationId } })
      assert.equal(afterRotate.shareTokenDigest, hashToken(rotated.shareToken))

      const disabled = await (await share(flow.id, { enabled: false, role: 'view' })).json()
      assert.equal(disabled.shareToken, null)
      assert.equal(disabled.shareEnabled, false)
      assert.equal((await prisma.flow.findFirst({ where: { id: flow.id, organizationId: s.organizationId } })).shareTokenDigest, null)
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })

  test('token acceptance upserts exactly one collaborator row (idempotent) and grants durable access; guests never see the token', async () => {
    const ownerOrg = await seedTestOrg(prisma)
    const guestOrg = await seedTestOrg(prisma)
    try {
      installTestAuth(ownerOrg.auth)
      const flow = await mkFlow(ownerOrg.organizationId, ownerOrg.userId)
      const { shareToken } = await (await share(flow.id, { enabled: true, role: 'edit' })).json()
      installTestAuth(guestOrg.auth)
      assert.equal((await open(flow.id)).status, 404, 'no token, no row → invisible')
      assert.equal((await open(flow.id, 'wrong-token')).status, 404, 'bad token → invisible')
      const first = await open(flow.id, shareToken)
      assert.equal(first.status, 200)
      const body = await first.json()
      assert.equal(body.flow.role, 'edit')
      assert.equal(body.flow.external, true)
      assert.ok(!('shareToken' in body.flow), 'guests never receive the token')
      await open(flow.id, shareToken) // idempotent re-open
      const rows = await prisma.flowCollaborator.findMany({ where: { flowId: flow.id, userId: guestOrg.userId } })
      assert.equal(rows.length, 1, 'exactly one collaborator row')
      assert.equal((await open(flow.id)).status, 200, 'the row grants access without the token')
    } finally {
      await ownerOrg.cleanup(); await guestOrg.cleanup()
      await prisma.organization.delete({ where: { id: ownerOrg.organizationId } }).catch(() => {})
      await prisma.organization.delete({ where: { id: guestOrg.organizationId } }).catch(() => {})
    }
  })
  test('collaborator management: editors list guests, remove one, and rotate-with-revoke clears the rest', async () => {
    const s = await seedTestOrg(prisma)
    const guestA = await seedTestOrg(prisma)
    const guestB = await seedTestOrg(prisma)
    const collaboratorsRoute = await import('../[id]/collaborators/route')
    const list = (flowId: string) =>
      collaboratorsRoute.GET(new NextRequest(new URL(`http://test/api/flows/${flowId}/collaborators`)))
    const removeOne = (flowId: string, userId: string) =>
      collaboratorsRoute.DELETE(new NextRequest(new URL(`http://test/api/flows/${flowId}/collaborators`), { method: 'DELETE', body: JSON.stringify({ userId }) }))
    try {
      installTestAuth(s.auth)
      const flow = await mkFlow(s.organizationId, s.userId)
      const minted = await (await share(flow.id, { enabled: true, role: 'view' })).json()
      // Both guests accept the link.
      for (const guest of [guestA, guestB]) {
        installTestAuth(guest.auth)
        const opened = await open(flow.id, minted.shareToken)
        assert.equal(opened.status, 200)
      }

      // Owner lists guests: both rows, with identity.
      installTestAuth(s.auth)
      const listed = await (await list(flow.id)).json()
      assert.equal(listed.collaborators.length, 2)
      const listedIds = listed.collaborators.map((c: { userId: string }) => c.userId).sort()
      assert.deepEqual(listedIds, [guestA.userId, guestB.userId].sort())

      // Remove one guest: their access is gone, the other keeps theirs.
      const removed = await removeOne(flow.id, guestA.userId)
      assert.equal(removed.status, 200)
      installTestAuth(guestA.auth)
      assert.equal((await open(flow.id)).status, 404, 'removed guest is refused')
      installTestAuth(guestB.auth)
      assert.equal((await open(flow.id)).status, 200, 'other guest keeps access')

      // A guest can never manage collaborators (org-scoped wall).
      assert.equal((await list(flow.id)).status, 404)

      // Rotate + revokeCollaborators clears the remaining accepted rows too.
      installTestAuth(s.auth)
      const rotated = await (await share(flow.id, { enabled: true, role: 'view', rotate: true, revokeCollaborators: true })).json()
      assert.equal(rotated.revokedCollaborators, 1)
      installTestAuth(guestB.auth)
      assert.equal((await open(flow.id)).status, 404, 'revoked guest is refused after rotate')
    } finally {
      for (const w of [s, guestA, guestB]) {
        await w.cleanup()
        await prisma.organization.delete({ where: { id: w.organizationId } }).catch(() => {})
      }
    }
  })
  test('anonymous opt-in is view-only and dies with the link; the token alone never grants it', async () => {
    const s = await seedTestOrg(prisma)
    const { resolveAnonymousFlowShare } = await import('@/lib/flows/public-share')
    try {
      installTestAuth(s.auth)
      const flow = await mkFlow(s.organizationId, s.userId)

      // Sharing without the anonymous flag: the token does NOT open publicly.
      const minted = await (await share(flow.id, { enabled: true, role: 'edit' })).json()
      assert.equal(minted.shareAnonymous, false)
      assert.equal((await resolveAnonymousFlowShare(minted.shareToken, { clientKey: 'anon-1', countView: false })).status, 'not_found')

      // Opting in works even when the ROLE is edit — anonymous is always
      // read-only, and never becomes an editable grant.
      const opened = await (await share(flow.id, { enabled: true, role: 'edit', anonymous: true })).json()
      assert.equal(opened.shareAnonymous, true)
      assert.equal(opened.shareToken, null, 'opting in does not rotate — and never re-issues the plaintext')
      // The token the owner was handed at mint still resolves, via its digest.
      const anon = await resolveAnonymousFlowShare(minted.shareToken, { clientKey: 'anon-2', countView: false })
      assert.equal(anon.status, 'ok')

      // Rotating kills the old public URL and resets the counter.
      await resolveAnonymousFlowShare(minted.shareToken, { clientKey: 'anon-3' })
      const rotated = await (await share(flow.id, { enabled: true, role: 'view', rotate: true, anonymous: true })).json()
      assert.ok(rotated.shareToken && rotated.shareToken !== minted.shareToken)
      assert.equal(rotated.anonymousViews, 0, 'the view count resets with the link')
      assert.equal((await resolveAnonymousFlowShare(minted.shareToken, { clientKey: 'anon-4', countView: false })).status, 'not_found')

      // Turning sharing off ends anonymous access entirely.
      const disabled = await (await share(flow.id, { enabled: false, role: 'view' })).json()
      assert.equal(disabled.shareAnonymous, false)
      assert.equal((await resolveAnonymousFlowShare(rotated.shareToken, { clientKey: 'anon-5', countView: false })).status, 'not_found')
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })
}
