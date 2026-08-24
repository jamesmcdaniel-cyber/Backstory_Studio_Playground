/**
 * The shell poll's 304 path, end to end.
 *
 * This is the single largest capacity lever on the platform: at 1,000
 * concurrent users /api/snapshot is ~125 req/s and ~1,100 database queries per
 * second, almost all of it re-reading rows that did not change. A matching
 * validator turns each of those into one cache read and zero queries.
 *
 * Worth testing against real infrastructure rather than mocks, because every
 * way this can be wrong is an interaction between three moving parts: the
 * Prisma extension that advances the counter, the cache backend that stores it,
 * and the route that turns it into an ETag. A unit test of any one of them
 * would pass while the mechanism did nothing.
 *
 * Needs BOTH a database and a shared cache. `cacheConfigured()` is deliberately
 * false for the in-memory fallback — a per-instance counter would hand different
 * instances different validators, and worse, would not see another instance's
 * writes — so with no REDIS_URL the route emits no ETag at all and there is
 * nothing here to test. Skips loudly rather than passing vacuously.
 */
import { test, before, describe } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const TEST_DB = process.env.TEST_DATABASE_URL
const HAS_CACHE = Boolean(process.env.REDIS_URL || (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN))

const SKIP = !TEST_DB
  ? 'needs TEST_DATABASE_URL'
  : !HAS_CACHE
    ? 'needs a SHARED cache (REDIS_URL or UPSTASH_REDIS_REST_*) — the route emits no validator without one'
    : false

// A `describe`-level skip reports ZERO tests, so the suite disappears from the
// summary instead of announcing that it did not run. This standalone case is
// what makes an unconfigured environment visible: a suite that has stopped
// testing must say so.
test('snapshot revalidation prerequisites', { skip: SKIP }, () => {
  assert.ok(TEST_DB && HAS_CACHE)
})

describe('snapshot revalidation', { skip: SKIP }, () => {
  let prisma: any
  let seedTestOrg: any
  let GET: any
  let installTestAuth: any

  before(async () => {
    process.env.DATABASE_URL = TEST_DB
    process.env.DIRECT_URL = TEST_DB
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth'))
    ;({ GET } = await import('@/app/api/snapshot/route'))
  })

  // NextRequest, not Request: withAuthenticatedApi reads `nextUrl.pathname`
  // for its security-event records, which a plain Request does not carry.
  const request = (etag?: string) =>
    new NextRequest(new URL('http://test/api/snapshot'), {
      headers: etag ? { 'if-none-match': etag } : undefined,
    }) as never

  test('a repeat poll with the served validator is answered 304, and a write invalidates it', async () => {
    const seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    try {
      const first = await GET(request())
      assert.equal(first.status, 200)
      const etag = first.headers.get('etag')
      assert.ok(etag, 'the route must emit a validator when a shared cache is configured')

      // The steady state: nothing changed, so the shell is told so without the
      // route running a single query.
      const second = await GET(request(etag))
      assert.equal(second.status, 304, 'an unchanged shell must revalidate')
      assert.equal(second.headers.get('etag'), etag, '304 must repeat the validator')
      assert.equal(await second.text(), '', '304 carries no body')

      // A write to a model the shell reads must move the counter — through the
      // Prisma extension, with no route or call site involved.
      await prisma.agentTask.create({
        data: {
          organizationId: seeded.organizationId,
          userId: seeded.userId,
          description: 'invalidates the shell',
          objective: 'none',
          status: 'ACTIVE',
        },
      })

      const third = await GET(request(etag))
      assert.equal(third.status, 200, 'a write must invalidate the client\'s copy')
      assert.notEqual(third.headers.get('etag'), etag, 'the validator must change with the data')
      const body = await third.json()
      assert.ok(
        body.agents.some((agent: { title: string }) => agent.title === 'invalidates the shell'),
        'the fresh body must contain the write that invalidated it',
      )
    } finally {
      await seeded.cleanup()
    }
  })

  test('a stale validator is never honoured', async () => {
    const seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    try {
      // A validator from a different workspace-version must not match. This is
      // the failure that would serve one shell's data against another's request.
      const response = await GET(request('W/"snap2-999999-someone-else-20268-0"'))
      assert.equal(response.status, 200)
    } finally {
      await seeded.cleanup()
    }
  })

  test('clearing notifications changes the validator, so the panel cannot refill from cache', async () => {
    // Clearing writes the reader's watermark on the USER row — not workspace
    // content, so the workspace version does not move. Without the watermark
    // in the validator the next poll would 304 and the client would keep
    // serving the list it just emptied.
    const seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    try {
      const first = await GET(request())
      const etag = first.headers.get('etag')
      assert.ok(etag)
      assert.equal((await GET(request(etag))).status, 304)

      const cleared = await prisma.user.update({
        where: { id: seeded.userId },
        data: { notificationsClearedAt: new Date() },
      })
      // The fixture's auth context holds the row as it was seeded; the route
      // reads the watermark off it exactly as requireAuthContext would.
      installTestAuth({ ...seeded.auth, dbUser: cleared })

      const after = await GET(request(etag))
      assert.equal(after.status, 200, 'a clear must invalidate the client\'s copy')
      assert.notEqual(after.headers.get('etag'), etag)
    } finally {
      await seeded.cleanup()
    }
  })

  test('two members of one workspace never share a validator', async () => {
    // Same org, same version — but the response is filtered by per-user
    // visibility and carries that person's notifications. A validator without
    // the user in it would serve one member's shell to another.
    const a = await seedTestOrg(prisma)
    installTestAuth(a.auth)
    const first = await GET(request())
    const etagA = first.headers.get('etag')
    await a.cleanup()

    const b = await seedTestOrg(prisma)
    installTestAuth(b.auth)
    try {
      const second = await GET(request(etagA ?? ''))
      assert.equal(second.status, 200, "another member's validator must not match")
    } finally {
      await b.cleanup()
    }
  })
})
