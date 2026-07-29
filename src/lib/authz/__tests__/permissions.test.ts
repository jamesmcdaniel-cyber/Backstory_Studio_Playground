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

test('a customer admin can never submit or review, whatever their org role', () => {
  for (const role of ['VIEWER', 'USER', 'ADMIN', 'OWNER'] as const) {
    const p = resolvePermissions({ role, platformRole: null }, customer)
    assert.ok(!p.has('template.submit'), role)
    assert.ok(!p.has('catalogue.review'), role)
    assert.ok(!p.has('catalogue.publish'), role)
    assert.ok(!p.has('catalogue.takedown'), role)
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

test('a reviewer flag on a customer org grants nothing (defence in depth)', () => {
  const p = resolvePermissions({ role: 'ADMIN', platformRole: 'reviewer' }, customer)
  assert.ok(!p.has('catalogue.review'))
  assert.ok(!p.has('template.submit'))
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
