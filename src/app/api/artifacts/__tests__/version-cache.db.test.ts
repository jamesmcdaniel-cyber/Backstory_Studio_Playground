import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * A saved version's page is cached by the browser (it never changes once
 * saved), revalidates with a 304, and "current" — which moves — is never
 * cached. The ROI page and revisited artifacts open from the cache.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let seedTestOrg: any
  let installTestAuth: any
  let contentRoute: any

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    contentRoute = await import('../[id]/versions/[versionId]/content/route')
  })

  const req = (path: string, headers: Record<string, string> = {}) => new NextRequest(new URL(`http://test${path}`), { headers })

  test('a saved version is cached by the browser and revalidates with 304; "current" never is', async () => {
    const s = await seedTestOrg(prisma)
    try {
      installTestAuth(s.auth)
      const artifact = await prisma.artifact.create({ data: { organizationId: s.organizationId, userId: s.userId, title: 'Report', kind: 'page' } })
      const version = await prisma.artifactVersion.create({ data: { organizationId: s.organizationId, artifactId: artifact.id, number: 1, content: '<!doctype html><html><body><h1>Report</h1></body></html>' } })
      await prisma.artifact.update({ where: { id: artifact.id, organizationId: s.organizationId }, data: { currentVersionId: version.id, versionCount: 1 } })

      const first = await contentRoute.GET(req(`/api/artifacts/${artifact.id}/versions/${version.id}/content`))
      assert.equal(first.status, 200)
      assert.equal(first.headers.get('cache-control'), 'private, max-age=86400')
      const etag = first.headers.get('etag')
      assert.ok(etag && etag.startsWith(`"${version.id}.`))
      assert.match(await first.text(), /<h1>Report<\/h1>/)

      const again = await contentRoute.GET(req(`/api/artifacts/${artifact.id}/versions/${version.id}/content`, { 'if-none-match': etag! }))
      assert.equal(again.status, 304)
      assert.equal(await again.text(), '')

      const current = await contentRoute.GET(req(`/api/artifacts/${artifact.id}/versions/current/content`))
      assert.equal(current.status, 200)
      assert.equal(current.headers.get('cache-control'), 'private, no-store')
      assert.equal(current.headers.get('etag'), null)
    } finally {
      await s.cleanup()
    }
  })
}
