import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolvePermissions } from '../permissions'

/**
 * Pins the demo-mode privilege contract: a demo org's kind grants NOTHING.
 * Permissions inside a demo session are resolved from the real workspace
 * before the tenant swap (src/lib/server/auth.ts), so 'demo' appearing in
 * REVIEWING_ORG_KINDS or OPERATING_ORG_KINDS would be a privilege leak, not a
 * feature. If a future change needs reviewers working inside a sandbox, it
 * must go through the swap design, not through these sets.
 */
test("kind 'demo' grants a reviewer no catalogue or operator permissions", () => {
  const granted = resolvePermissions(
    { role: 'ADMIN', platformRole: 'reviewer', email: 'reviewer@example.com' },
    { kind: 'demo' },
  )
  assert.ok(!granted.has('catalogue.review'))
  assert.ok(!granted.has('catalogue.publish'))
  assert.ok(!granted.has('catalogue.takedown'))
  assert.ok(!granted.has('platform.administer'))
})

test("kind 'demo' still carries ordinary role permissions", () => {
  const granted = resolvePermissions(
    { role: 'ADMIN', platformRole: null, email: 'someone@example.com' },
    { kind: 'demo' },
  )
  assert.ok(granted.has('flow.read'))
})
