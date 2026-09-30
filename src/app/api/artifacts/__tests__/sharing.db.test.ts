import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let resolvePermissions: any
  let sharingRoute: any
  let artifactRoute: any
  let chatRoute: any
  let publicContent: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    ;({ resolvePermissions } = await import('@/lib/authz/permissions'))
    sharingRoute = await import('../[id]/sharing/route')
    artifactRoute = await import('../[id]/route')
    chatRoute = await import('../[id]/chat/route')
    publicContent = await import('../../share/artifacts/[token]/content/route')
  })

  const req = (path: string, method = 'GET', body?: unknown) =>
    new NextRequest(new URL(`http://test${path}`), { method, ...(body ? { body: JSON.stringify(body) } : {}) })

  /** A second person in the same workspace, with their own role. */
  async function member(prismaClient: any, owner: any, role: 'USER' | 'VIEWER') {
    const user = await prismaClient.user.create({
      data: { supabaseId: crypto.randomUUID(), email: `${role.toLowerCase()}-${crypto.randomUUID()}@example.test`, name: role, role, organizationId: owner.organizationId },
    })
    const permissions = resolvePermissions({ role: user.role, platformRole: user.platformRole }, { kind: 'customer' })
    return { ...owner.auth, dbUser: user, userId: user.supabaseId, permissions, can: (p: string) => permissions.has(p) }
  }

  test('sharing: editors whatever their role, view-only refusals, and the public link lifecycle', async () => {
    const s = await seedTestOrg(prisma, { role: 'USER' })
    try {
      const artifact = await prisma.artifact.create({ data: { organizationId: s.organizationId, userId: s.userId, title: 'Cockpit', kind: 'page' } })
      const version = await prisma.artifactVersion.create({
        data: { organizationId: s.organizationId, artifactId: artifact.id, number: 1, content: '<!doctype html><html><body><h1>Cockpit</h1><script>1</script></body></html>' },
      })
      await prisma.artifact.update({ where: { id: artifact.id, organizationId: s.organizationId }, data: { currentVersionId: version.id, versionCount: 1 } })
      const viewerAuth = await member(prisma, s, 'VIEWER')
      const memberAuth = await member(prisma, s, 'USER')

      // A Viewer opens it but cannot change it.
      installTestAuth(viewerAuth)
      const seen = await (await artifactRoute.GET(req(`/api/artifacts/${artifact.id}`))).json()
      assert.equal(seen.artifact.permissions.canEdit, false)
      assert.equal((await chatRoute.POST(req(`/api/artifacts/${artifact.id}/chat`, 'POST', { message: 'Tighten it' }))).status, 403)
      assert.equal((await sharingRoute.PATCH(req(`/api/artifacts/${artifact.id}/sharing`, 'PATCH', { editorIds: [viewerAuth.dbUser.id] }))).status, 403, 'a viewer cannot grant themselves edit')

      // The owner names the Viewer as an editor; they are notified and can now edit.
      installTestAuth(s.auth)
      const granted = await (await sharingRoute.PATCH(req(`/api/artifacts/${artifact.id}/sharing`, 'PATCH', { editorIds: [viewerAuth.dbUser.id, 'not-in-workspace'] }))).json()
      assert.deepEqual(granted.editors.map((e: any) => e.id), [viewerAuth.dbUser.id], 'only workspace members become editors')
      assert.equal(await prisma.notification.count({ where: { organizationId: s.organizationId, userId: viewerAuth.dbUser.id, type: 'artifact.shared' } }), 1)
      installTestAuth(viewerAuth)
      assert.equal((await (await artifactRoute.GET(req(`/api/artifacts/${artifact.id}`))).json()).artifact.permissions.reason, 'editor')

      // Workspace access "view": a member whose role can edit loses edit on this artifact.
      installTestAuth(s.auth)
      await sharingRoute.PATCH(req(`/api/artifacts/${artifact.id}/sharing`, 'PATCH', { workspaceAccess: 'view' }))
      installTestAuth(memberAuth)
      assert.equal((await artifactRoute.PATCH(req(`/api/artifacts/${artifact.id}`, 'PATCH', { archived: true }))).status, 403)

      // Public link: mint, copy again, open without a session, rotate, disable.
      installTestAuth(s.auth)
      const minted = await (await sharingRoute.PATCH(req(`/api/artifacts/${artifact.id}/sharing`, 'PATCH', { link: 'enable' }))).json()
      assert.match(minted.link.url, /\/share\/artifact\/[A-Za-z0-9_-]{32}$/)
      const token = minted.link.url.split('/').at(-1)
      const stored = await prisma.artifact.findFirst({ where: { id: artifact.id, organizationId: s.organizationId } })
      assert.equal(JSON.stringify(stored).includes(token), false, 'the raw token is not stored')
      const again = await (await sharingRoute.GET(req(`/api/artifacts/${artifact.id}/sharing`))).json()
      assert.equal(again.link.url, minted.link.url, 'editors can copy the same link again')
      const page = await publicContent.GET(req(`/api/share/artifacts/${token}/content`))
      assert.equal(page.status, 200)
      assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts/)
      assert.match(await page.text(), /<h1>Cockpit<\/h1>/)
      const rotated = await (await sharingRoute.PATCH(req(`/api/artifacts/${artifact.id}/sharing`, 'PATCH', { link: 'rotate' }))).json()
      assert.notEqual(rotated.link.url, minted.link.url)
      assert.equal((await publicContent.GET(req(`/api/share/artifacts/${token}/content`))).status, 404, 'the old link stops working')
      await sharingRoute.PATCH(req(`/api/artifacts/${artifact.id}/sharing`, 'PATCH', { link: 'disable' }))
      assert.equal((await publicContent.GET(req(`/api/share/artifacts/${rotated.link.url.split('/').at(-1)}/content`))).status, 404)
      const audited = await prisma.auditEvent.count({ where: { organizationId: s.organizationId, resourceId: artifact.id, action: { startsWith: 'artifact.' } } })
      assert.ok(audited >= 5, `every sharing change is audited (${audited})`)
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })
}
