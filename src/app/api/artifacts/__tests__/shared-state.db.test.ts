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
  let route: any
  let privateRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    ;({ resolvePermissions } = await import('@/lib/authz/permissions'))
    route = await import('../[id]/shared-state/route')
    privateRoute = await import('../[id]/state/route')
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

  test('shared state: one value for everyone who opens the artifact, compare-and-set, readers read and editors write', async () => {
    const s = await seedTestOrg(prisma, { role: 'USER' })
    try {
      const artifact = await prisma.artifact.create({ data: { organizationId: s.organizationId, userId: s.userId, title: 'Sign-up sheet', kind: 'page' } })
      const version = await prisma.artifactVersion.create({ data: { organizationId: s.organizationId, artifactId: artifact.id, number: 1, content: '<!doctype html><html><body><h1>Sheet</h1><script>1</script></body></html>' } })
      await prisma.artifact.update({ where: { id: artifact.id, organizationId: s.organizationId }, data: { currentVersionId: version.id, versionCount: 1 } })
      const path = `/api/artifacts/${artifact.id}/shared-state`
      installTestAuth(s.auth)

      const empty = await (await route.GET(req(`${path}?key=sheet-v1`))).json()
      assert.deepEqual([empty.value, empty.revision], [null, 0])
      const first = await (await route.PUT(req(path, 'PUT', { key: 'sheet-v1', revision: 0, value: { rows: ['a'] }, versionId: version.id }))).json()
      assert.equal(first.revision, 1, JSON.stringify(first))
      assert.equal((await route.PUT(req(path, 'PUT', { key: 'sheet-v1', revision: 0, value: { rows: [] }, versionId: version.id }))).status, 409, 'a stale revision is refused')
      const second = await (await route.PUT(req(path, 'PUT', { key: 'sheet-v1', revision: 1, value: { rows: ['a', 'b'] }, versionId: version.id }))).json()
      assert.equal(second.revision, 2)
      assert.equal((await route.PUT(req(path, 'PUT', { key: 'sheet-v1', revision: 2, value: {}, versionId: 'stale-version' }))).status, 409, 'a stale source version is refused')
      assert.equal((await route.GET(req(`${path}?key=bad key!`))).status, 400)
      assert.equal((await route.PUT(req(path, 'PUT', { key: 'big', revision: 0, value: 'x'.repeat(257_000), versionId: version.id }))).status, 413)

      // Another member reads the SAME value — it is the artifact's, not the person's — and may write it.
      const colleague = await member(prisma, s, 'USER')
      installTestAuth(colleague)
      const theirs = await (await route.GET(req(`${path}?key=sheet-v1`))).json()
      assert.deepEqual([theirs.value, theirs.revision], [{ rows: ['a', 'b'] }, 2])
      assert.equal((await route.PUT(req(path, 'PUT', { key: 'sheet-v1', revision: 2, value: { rows: ['a', 'b', 'c'] }, versionId: version.id }))).status, 200)

      // A viewer reads it and cannot write it.
      installTestAuth(await member(prisma, s, 'VIEWER'))
      const viewed = await (await route.GET(req(`${path}?key=sheet-v1`))).json()
      assert.deepEqual(viewed.value, { rows: ['a', 'b', 'c'] })
      assert.equal((await route.PUT(req(path, 'PUT', { key: 'sheet-v1', revision: 3, value: {}, versionId: version.id }))).status, 403)

      const row = await prisma.artifactSharedState.findFirst({ where: { organizationId: s.organizationId, artifactId: artifact.id, key: 'sheet-v1' } })
      assert.equal(row.revision, 3)
      assert.equal(row.updatedByUserId, colleague.dbUser.id, 'the last writer is recorded')

      // Private state under the same key is a different value.
      installTestAuth(s.auth)
      const mine = await (await privateRoute.GET(req(`/api/artifacts/${artifact.id}/state?key=sheet-v1`))).json()
      assert.deepEqual([mine.value, mine.revision], [null, 0])
    } finally {
      await s.cleanup()
      await prisma.organization.delete({ where: { id: s.organizationId } }).catch(() => {})
    }
  })
}
