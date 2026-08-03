import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { applyStaffBootstrap } from '@/lib/supabase/auth-utils'

const priorEmails = process.env.PLATFORM_STAFF_EMAILS

afterEach(() => {
  delete process.env.APP_EDITION
  if (priorEmails === undefined) delete process.env.PLATFORM_STAFF_EMAILS
  else process.env.PLATFORM_STAFF_EMAILS = priorEmails
})

const customerUser = {
  id: 'user-1',
  email: 'operator@example.com',
  platformRole: null,
  organizationId: 'org-1',
  organization: { id: 'org-1', kind: 'customer' },
} as unknown as Parameters<typeof applyStaffBootstrap>[0]

describe('staff bootstrap', () => {
  test('is inert in the customer edition even when the email is allowlisted', async () => {
    process.env.APP_EDITION = 'customer'
    process.env.PLATFORM_STAFF_EMAILS = 'operator@example.com'

    // Returns before any DB write. Reaching Prisma here would throw, so an
    // unmodified return IS the proof that no escalation occurred.
    const result = await applyStaffBootstrap(customerUser)

    assert.equal(result, customerUser)
    assert.equal(result.platformRole, null, 'must not be promoted to reviewer')
    assert.equal(result.organization?.kind, 'customer', 'workspace must not become internal')
  })

  test('is inert for a non-allowlisted email in the internal edition', async () => {
    delete process.env.APP_EDITION
    process.env.PLATFORM_STAFF_EMAILS = 'someone-else@example.com'

    const result = await applyStaffBootstrap(customerUser)

    assert.equal(result, customerUser)
  })
})
