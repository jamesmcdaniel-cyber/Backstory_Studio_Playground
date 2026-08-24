import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { noteUserMutation, reviveDates } from '@/lib/server/auth-cache'

describe('noteUserMutation', () => {
  it('evicts on a write to a User row keyed by supabaseId', () => {
    assert.notEqual(noteUserMutation('User', 'update', { where: { supabaseId: 'sb_1' } }), null)
  })

  it('evicts on a write keyed by primary key — the shape almost every route uses', () => {
    // The original production bug was a role change and a member removal that
    // never invalidated. Both target the row by id.
    assert.notEqual(noteUserMutation('User', 'update', { where: { id: 'usr_1' } }), null)
    assert.notEqual(noteUserMutation('User', 'delete', { where: { id: 'usr_1' } }), null)
  })

  it('ignores reads', () => {
    for (const operation of ['findUnique', 'findFirst', 'findMany', 'count']) {
      assert.equal(noteUserMutation('User', operation, { where: { id: 'usr_1' } }), null, operation)
    }
  })

  it('ignores every other model', () => {
    assert.equal(noteUserMutation('AgentTask', 'update', { where: { id: 'a_1' } }), null)
    assert.equal(noteUserMutation(undefined, 'update', { where: { id: 'a_1' } }), null)
  })

  it('does not flush anything for a bulk write it cannot attribute', () => {
    // A deliberate no-op, not an oversight: letting an unattributable updateMany
    // clear the cache would give any bulk write a platform-wide flush.
    assert.equal(noteUserMutation('User', 'updateMany', { where: { organizationId: 'org_1' } }), null)
  })
})

describe('reviveDates', () => {
  it('restores every DateTime column User and Organization actually declare', () => {
    const row = reviveDates({
      id: 'usr_1',
      email: 'a@example.com',
      lastSeenAt: '2026-08-23T10:00:00.000Z',
      runAllowanceResetAt: '2026-08-23T10:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-23T09:00:00.000Z',
      organization: {
        id: 'org_1',
        entitlementCheckedAt: '2026-08-23T08:00:00.000Z',
        trialStartDate: '2026-08-01T00:00:00.000Z',
        trialEndDate: '2026-09-01T00:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-23T08:00:00.000Z',
      },
    }) as Record<string, unknown> & { organization: Record<string, unknown> }

    for (const key of ['lastSeenAt', 'runAllowanceResetAt', 'createdAt', 'updatedAt']) {
      assert.ok(row[key] instanceof Date, `user.${key}`)
    }
    for (const key of ['entitlementCheckedAt', 'trialStartDate', 'trialEndDate', 'createdAt', 'updatedAt']) {
      assert.ok(row.organization[key] instanceof Date, `organization.${key}`)
    }
  })

  it('leaves nulls, non-dates and unrelated strings alone', () => {
    const row = reviveDates({
      lastSeenAt: null,
      email: 'a@example.com',
      role: 'ADMIN',
      // Named like a date, but not one — must not become an Invalid Date.
      trialEndDate: 'never',
    }) as Record<string, unknown>
    assert.equal(row.lastSeenAt, null)
    assert.equal(row.email, 'a@example.com')
    assert.equal(row.trialEndDate, 'never')
  })

  it('does not retype a date-shaped string under an unrelated key', () => {
    // `slug` is not a DateTime column, and guessing from the value alone would
    // hand the caller a Date where the schema promises a string.
    const row = reviveDates({ slug: '2026-08-23T10:00:00.000Z' }) as Record<string, unknown>
    assert.equal(typeof row.slug, 'string')
  })

  it('round-trips through JSON the way the cache backend will', () => {
    const original = { createdAt: new Date('2026-08-23T10:00:00.000Z'), name: 'Acme' }
    const revived = reviveDates(JSON.parse(JSON.stringify(original))) as typeof original
    assert.ok(revived.createdAt instanceof Date)
    assert.equal(revived.createdAt.toISOString(), original.createdAt.toISOString())
    assert.equal(revived.name, 'Acme')
  })
})
