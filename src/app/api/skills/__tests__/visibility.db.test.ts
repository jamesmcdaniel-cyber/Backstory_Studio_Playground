import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { NextRequest } from 'next/server'

/**
 * The skill library's tenancy boundary: a workspace sees its own skills at any
 * visibility plus other workspaces' PUBLISHED ones, and never another
 * workspace's org-scoped ones.
 *
 * Before the review gate this table had no visibility column at all — every
 * row was served to every org — so this is the widest of the three catalogue
 * holes, and the one with no prior scoping to preserve.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  let seeded: any
  let otherOrgId: string

  const mkSkill = (organizationId: string, name: string, visibility: string) =>
    prisma.sharedSkill.create({
      data: { name, instructions: 'do a thing', organizationId, visibility },
    })

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const { seedTestOrg, installTestAuth } = await import('@/lib/server/__tests__/test-auth')
    seeded = await seedTestOrg(prisma)
    installTestAuth(seeded.auth)
    const other = await prisma.organization.create({
      data: { name: 'other', slug: `other-${crypto.randomUUID()}` },
    })
    otherOrgId = other.id
    await mkSkill(seeded.organizationId, 'mine-org', 'org')
    await mkSkill(otherOrgId, 'theirs-published', 'global')
    await mkSkill(otherOrgId, 'theirs-private', 'org')
  })

  after(async () => {
    if (otherOrgId) await prisma.organization.delete({ where: { id: otherOrgId } }).catch(() => {})
    if (seeded) await seeded.cleanup()
  })

  test('the library shows own skills and other orgs published ones only', async () => {
    const { GET } = await import('../route')
    const response = await GET(new NextRequest(new URL('http://test/api/skills')))
    const body = await response.json()
    const names = body.skills.filter((s: any) => s.custom).map((s: any) => s.name)

    assert.ok(names.includes('mine-org'), 'own org-scoped skill must be visible')
    assert.ok(names.includes('theirs-published'), 'another org published skill must be visible')
    assert.ok(!names.includes('theirs-private'), 'another org org-scoped skill must be hidden')
  })

  test('a newly created skill is org-scoped, not published', async () => {
    const { POST } = await import('../route')
    const response = await POST(new NextRequest(new URL('http://test/api/skills'), {
      method: 'POST',
      body: JSON.stringify({ name: 'fresh', instructions: 'do a thing' }),
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(response.status, 200)
    const row = await prisma.sharedSkill.findFirst({
      where: { organizationId: seeded.organizationId, name: 'fresh' },
    })
    assert.equal(row.visibility, 'org')
    assert.equal(row.catalogueStatus, 'none')
  })
}
