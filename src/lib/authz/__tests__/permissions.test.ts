import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PERMISSIONS, resolvePermissions } from '../permissions'

const customer = { kind: 'customer' }
const partner = { kind: 'partner' }
const internal = { kind: 'internal' }
const member = { role: 'USER' as const, platformRole: null }
const admin = { role: 'ADMIN' as const, platformRole: null }
const viewer = { role: 'VIEWER' as const, platformRole: null }
const reviewer = { role: 'ADMIN' as const, platformRole: 'reviewer' }

test('a viewer reads but cannot write, run, or author', () => {
  const p = resolvePermissions(viewer, customer)
  assert.ok(p.has('flow.read'))
  assert.ok(p.has('agent.read'))
  assert.ok(!p.has('flow.write'))
  assert.ok(!p.has('flow.run'))
  assert.ok(!p.has('template.author'))
})

test('role bundles are cumulative', () => {
  const m = resolvePermissions(member, customer)
  assert.ok(m.has('flow.read') && m.has('flow.write') && m.has('template.author'))
  assert.ok(!m.has('members.manage'))

  const a = resolvePermissions(admin, customer)
  assert.ok(a.has('flow.write')) // inherited from USER
  assert.ok(a.has('members.manage') && a.has('integration.manage') && a.has('audit.read'))

  const o = resolvePermissions({ role: 'OWNER', platformRole: null }, customer)
  assert.ok(o.has('members.manage') && o.has('org.manage'))
})

test('OWNER is the root tier: every permission, in every org kind', () => {
  for (const org of [customer, partner, internal]) {
    const p = resolvePermissions({ role: 'OWNER', platformRole: null }, org)
    for (const permission of PERMISSIONS) assert.ok(p.has(permission), `${permission} in ${org.kind}`)
  }
})

test('the platform owner email resolves every permission regardless of stored role', () => {
  // Identity-based: even a tampered role column cannot strip the owner.
  for (const email of ['james.mcdaniel@people.ai', 'James.McDaniel@Backstory.ai']) {
    const p = resolvePermissions({ role: 'VIEWER', platformRole: null, email }, customer)
    for (const permission of PERMISSIONS) assert.ok(p.has(permission), `${permission} for ${email}`)
  }
  // Any other identity gains nothing from the email field.
  const stranger = resolvePermissions({ role: 'VIEWER', platformRole: null, email: 'foe@example.com' }, customer)
  assert.ok(!stranger.has('members.manage'))
})

test('a customer workspace may submit — external contributions are the point', () => {
  // Anyone who can author a template can propose it; the review queue, not the
  // org kind, is what keeps the catalogue clean.
  for (const role of ['USER', 'ADMIN'] as const) {
    const p = resolvePermissions({ role, platformRole: null }, customer)
    assert.ok(p.has('template.author'), role)
    assert.ok(p.has('template.submit'), role)
  }
  // A viewer authors nothing, so it proposes nothing.
  const v = resolvePermissions(viewer, customer)
  assert.ok(!v.has('template.submit'))
})

test('no customer role can ever review, publish, or take down', () => {
  // OWNER is excluded: it is the platform root tier, held only by the platform
  // owner identities, and holds everything by design.
  for (const role of ['VIEWER', 'USER', 'ADMIN'] as const) {
    const p = resolvePermissions({ role, platformRole: null }, customer)
    assert.ok(!p.has('catalogue.review'), role)
    assert.ok(!p.has('catalogue.publish'), role)
    assert.ok(!p.has('catalogue.takedown'), role)
  }
})

test('reviewing the queue and administering domains stay super-admin only', () => {
  // Both surfaces are gated on catalogue.review (/admin/layout.tsx and the
  // /api/admin/domains + /api/catalogue/* routes). Only two identities reach
  // it: a platform owner, or someone promoted to reviewer inside a staff org.
  const owner = resolvePermissions({ role: 'VIEWER', platformRole: null, email: 'james.mcdaniel@backstory.ai' }, customer)
  assert.ok(owner.has('catalogue.review'))

  const promoted = resolvePermissions({ role: 'USER', platformRole: 'reviewer' }, internal)
  assert.ok(promoted.has('catalogue.review'))

  // Everyone else — including an admin of an external workspace that submits.
  for (const org of [customer, partner, internal]) {
    for (const role of ['VIEWER', 'USER', 'ADMIN'] as const) {
      const p = resolvePermissions({ role, platformRole: null, email: 'someone@customer.com' }, org)
      assert.ok(!p.has('catalogue.review'), `${role} in ${org.kind}`)
    }
  }
})

test('a partner member may submit but not review', () => {
  const p = resolvePermissions(member, partner)
  assert.ok(p.has('template.submit'))
  assert.ok(!p.has('catalogue.review'))
  assert.ok(!p.has('catalogue.publish'))
})

test('internal orgs may submit; only a reviewer decides and publishes', () => {
  const staff = resolvePermissions({ role: 'USER', platformRole: 'staff' }, internal)
  assert.ok(staff.has('template.submit'))
  assert.ok(!staff.has('catalogue.review'))

  const r = resolvePermissions(reviewer, internal)
  assert.ok(r.has('catalogue.review') && r.has('catalogue.publish') && r.has('catalogue.takedown'))
})

test('the platform overlay is independent of the org role', () => {
  // A reviewer who is only a VIEWER in their workspace still reviews.
  const p = resolvePermissions({ role: 'VIEWER', platformRole: 'reviewer' }, internal)
  assert.ok(p.has('catalogue.review'))
  assert.ok(!p.has('flow.write'))
})

test('a reviewer flag on a customer org grants no review rights (defence in depth)', () => {
  // A reviewer who moves to a customer workspace loses the overlay without
  // anyone having to remember to clear the flag. They keep ordinary authoring.
  const p = resolvePermissions({ role: 'ADMIN', platformRole: 'reviewer' }, customer)
  assert.ok(!p.has('catalogue.review'))
  assert.ok(!p.has('catalogue.publish'))
  assert.ok(!p.has('catalogue.takedown'))
})

test('every resolved permission is a declared one', () => {
  const declared = new Set<string>(PERMISSIONS)
  for (const org of [customer, partner, internal]) {
    for (const role of ['VIEWER', 'USER', 'ADMIN', 'OWNER'] as const) {
      for (const platformRole of [null, 'staff', 'reviewer']) {
        for (const perm of resolvePermissions({ role, platformRole }, org)) {
          assert.ok(declared.has(perm), `${perm} is not in PERMISSIONS`)
        }
      }
    }
  }
})
