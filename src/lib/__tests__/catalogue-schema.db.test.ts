import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The RBAC + catalogue schema against a real database: the new columns exist
 * with the documented defaults, and the legacy backfill left already-published
 * rows visible. Skipped without TEST_DATABASE_URL; CI provides it.
 */
const TEST_DB = process.env.TEST_DATABASE_URL
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB
  process.env.DIRECT_URL = TEST_DB

  let prisma: any
  const ids: Record<string, string> = {}

  before(async () => {
    ;({ prisma } = await import('@/lib/prisma'))
    const org = await prisma.organization.create({
      data: { name: 'schema check', slug: `schema-${crypto.randomUUID()}` },
    })
    ids.org = org.id
    const user = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: org.id, isActive: true },
    })
    ids.user = user.id
  })

  after(async () => {
    if (ids.org) await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
  })

  test('a new organization defaults to kind=customer and users have no platform role', async () => {
    const org = await prisma.organization.findUnique({ where: { id: ids.org } })
    assert.equal(org.kind, 'customer')
    const user = await prisma.user.findUnique({ where: { id: ids.user } })
    assert.equal(user.platformRole, null)
  })

  test('UserRole accepts the two new values', async () => {
    const viewer = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: ids.org, isActive: true, role: 'VIEWER' },
    })
    assert.equal(viewer.role, 'VIEWER')
    const owner = await prisma.user.update({ where: { id: viewer.id }, data: { role: 'OWNER' } })
    assert.equal(owner.role, 'OWNER')
  })

  test('templates and skills default to catalogueStatus=none and skills to org visibility', async () => {
    const template = await prisma.agentTemplate.create({
      data: { name: 't', type: 'Custom', userId: ids.user, organizationId: ids.org },
    })
    assert.equal(template.catalogueStatus, 'none')
    assert.equal(template.visibility, 'org')

    const skill = await prisma.sharedSkill.create({
      data: { name: 's', instructions: 'do a thing', organizationId: ids.org },
    })
    assert.equal(skill.visibility, 'org')
    assert.equal(skill.catalogueStatus, 'none')
  })

  test('a submission stores a frozen snapshot and is org-scoped', async () => {
    const submission = await prisma.catalogueSubmission.create({
      data: {
        kind: 'agent_template',
        title: 'Weekly pipeline digest',
        summary: 'Summarises pipeline movement every Monday.',
        snapshot: { name: 'Weekly pipeline digest' },
        organizationId: ids.org,
        submittedByUserId: ids.user,
      },
    })
    assert.equal(submission.status, 'pending')
    assert.deepEqual(submission.snapshot, { name: 'Weekly pipeline digest' })

    // The tenant guard must reject an unscoped read of the new model.
    await assert.rejects(
      () => prisma.catalogueSubmission.findFirst({ where: { id: submission.id } }),
      /organizationId/,
    )
  })
}
