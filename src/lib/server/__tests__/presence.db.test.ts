import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The writer against a real database.
 *
 * The unit test covers the throttle arithmetic; this covers the part that was
 * actually broken for the column's whole life — that something writes it at
 * all — plus the staleness predicate that keeps concurrent instances from
 * turning presence into a write per request.
 */

const TEST_DB = process.env.TEST_DATABASE_URL

if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let recordPresence: (userId: string, now?: Date) => Promise<void>
  let resetPresenceCache: () => void
  let PRESENCE_WINDOW_MS: number

  const readSeen = async (id: string) =>
    (await prisma.user.findFirst({ where: { id }, select: { lastSeenAt: true } }))?.lastSeenAt ?? null

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    ;({ recordPresence, resetPresenceCache, PRESENCE_WINDOW_MS } = await import('../presence'))
    const { seedTestOrg } = await import('./test-auth')
    seeded = await seedTestOrg(prisma)
  })

  after(async () => { if (seeded) await seeded.cleanup() })

  test('a request marks the account as seen', async () => {
    resetPresenceCache()
    assert.equal(await readSeen(seeded.userId), null, 'fixture should start unseen')

    const now = new Date()
    await recordPresence(seeded.userId, now)

    const seen = await readSeen(seeded.userId)
    assert.ok(seen, 'lastSeenAt should be written')
    assert.ok(Math.abs(seen.getTime() - now.getTime()) < 2000, 'should record roughly now')
  })

  test('a second request inside the window does not move the timestamp', async () => {
    resetPresenceCache()
    const first = new Date()
    await recordPresence(seeded.userId, first)
    const afterFirst = await readSeen(seeded.userId)

    // Bypass the in-process throttle to prove the DATABASE predicate also holds
    // — this is what a second serverless instance would do.
    resetPresenceCache()
    await recordPresence(seeded.userId, new Date(first.getTime() + 1000))

    assert.equal((await readSeen(seeded.userId))!.getTime(), afterFirst!.getTime())
  })

  test('a request past the window moves it forward', async () => {
    resetPresenceCache()
    const first = new Date()
    await recordPresence(seeded.userId, first)
    const afterFirst = await readSeen(seeded.userId)

    resetPresenceCache()
    const later = new Date(first.getTime() + PRESENCE_WINDOW_MS + 1000)
    await recordPresence(seeded.userId, later)

    assert.ok((await readSeen(seeded.userId))!.getTime() > afterFirst!.getTime())
  })

  test('a deleted account is a no-op rather than a thrown error', async () => {
    resetPresenceCache()
    // updateMany on a missing row matches nothing; update() would throw P2025
    // and, being unawaited, surface as an unhandled rejection.
    await recordPresence('user-that-does-not-exist')
  })
}
