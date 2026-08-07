import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

/**
 * The users-table trigger (20260806090000_platform_owner_protection) against a
 * real database: the platform owner rows are immortal and immutable in the
 * ways that matter, no matter which client issues the write. Skipped without
 * TEST_DATABASE_URL; CI provides it.
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
      data: { name: 'owner guard', slug: `owner-${crypto.randomUUID()}` },
    })
    ids.org = org.id
    const owner = await prisma.user.create({
      data: {
        supabaseId: crypto.randomUUID(),
        organizationId: org.id,
        email: 'james.mcdaniel@backstory.ai',
        // Deliberately NOT 'OWNER' — the trigger must coerce it on insert.
        role: 'USER',
      },
    })
    ids.owner = owner.id
    const bystander = await prisma.user.create({
      data: { supabaseId: crypto.randomUUID(), organizationId: org.id, email: 'rep@example.com', role: 'ADMIN' },
    })
    ids.bystander = bystander.id
  })

  after(async () => {
    // Owner rows can't be deleted — detach so the org cascade can proceed.
    if (ids.owner) await prisma.user.update({ where: { id: ids.owner }, data: { organizationId: null } }).catch(() => {})
    if (ids.org) await prisma.organization.delete({ where: { id: ids.org } }).catch(() => {})
  })

  test('inserting an owner identity self-heals to an active OWNER', async () => {
    const row = await prisma.user.findUnique({ where: { id: ids.owner } })
    assert.equal(row.role, 'OWNER')
    assert.equal(row.isActive, true)
  })

  test('the owner cannot be demoted, deactivated, renamed, or deleted', async () => {
    await assert.rejects(() => prisma.user.update({ where: { id: ids.owner }, data: { role: 'ADMIN' } }), /OWNER_PROTECTED/)
    await assert.rejects(() => prisma.user.update({ where: { id: ids.owner }, data: { isActive: false } }), /OWNER_PROTECTED/)
    await assert.rejects(() => prisma.user.update({ where: { id: ids.owner }, data: { email: 'other@evil.com' } }), /OWNER_PROTECTED/)
    await assert.rejects(() => prisma.user.delete({ where: { id: ids.owner } }), /OWNER_PROTECTED/)
    // Bulk writes cannot sweep the owner up either.
    await assert.rejects(
      () => prisma.user.updateMany({ where: { organizationId: ids.org }, data: { isActive: false } }),
      /OWNER_PROTECTED/,
    )
    await prisma.user.updateMany({ where: { organizationId: ids.org }, data: { isActive: true } }).catch(() => {})
  })

  test('non-owner rows cannot take OWNER or an owner email', async () => {
    await assert.rejects(() => prisma.user.update({ where: { id: ids.bystander }, data: { role: 'OWNER' } }), /OWNER_RESERVED/)
    await assert.rejects(
      () => prisma.user.update({ where: { id: ids.bystander }, data: { email: 'James.McDaniel@People.ai' } }),
      /OWNER_RESERVED/,
    )
  })

  test('other fields on the owner row remain writable', async () => {
    const row = await prisma.user.update({ where: { id: ids.owner }, data: { name: 'James McDaniel', timezone: 'America/Denver' } })
    assert.equal(row.name, 'James McDaniel')
    assert.equal(row.role, 'OWNER')
  })
}
