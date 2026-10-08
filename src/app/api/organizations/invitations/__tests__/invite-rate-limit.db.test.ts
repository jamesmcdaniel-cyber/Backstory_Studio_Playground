import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

/**
 * A workspace may send at most 50 invitations an hour (200 a day). Each one is
 * an email carrying a join link in our name, so without a ceiling one admin
 * session could use the platform as a relay. DB-gated like its siblings.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB
  process.env.ENTITLEMENT_GATE = 'off'

  let prisma: any
  let cleanup: () => Promise<void>
  let organizationId: string
  let POST: (request: NextRequest) => Promise<Response>

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    const seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    organizationId = seeded.organizationId
    cleanup = seeded.cleanup
    ;({ POST } = await import('../route'))
  })

  after(async () => {
    await prisma.invitation.deleteMany({ where: { organizationId } }).catch(() => {})
    await cleanup()
  })

  const invite = (n: number) =>
    POST(new NextRequest('https://studio.example.com/api/organizations/invitations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `invitee-${n}@example.com`, role: 'USER' }),
    }))

  test('the 51st invitation in an hour is refused with a 429 that says why', async () => {
    for (let n = 1; n <= 50; n++) {
      const response = await invite(n)
      assert.equal(response.status, 200, `invitation ${n} should be created`)
    }
    const limited = await invite(51)
    assert.equal(limited.status, 429)
    const body = await limited.json()
    assert.equal(body.code, 'INVITE_RATE_LIMITED')
    assert.match(body.error, /50 invitations in an hour/)
    // Nothing was written for the refused call.
    assert.equal(await prisma.invitation.count({ where: { organizationId } }), 50)
  })
}
