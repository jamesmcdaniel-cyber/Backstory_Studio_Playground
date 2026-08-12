import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROLES, ALL_ROLES, hasRole, rolesFor } from '../roles'

test('a skill is placed by the audience it was written for', () => {
  assert.deepEqual(rolesFor({ category: 'Account Research & Planning', audience: ['AEs', 'CSMs'] }), ['CSM', 'Sales'])
  assert.deepEqual(rolesFor({ category: 'Platform Architecture & Adaptation', audience: ['Solutions Engineers'] }), ['IT'])
  assert.deepEqual(rolesFor({ category: 'Engagement Analytics', audience: ['RevOps'] }), ['Sales'])
})

test('a template with no audience is placed by its category', () => {
  assert.deepEqual(rolesFor({ category: 'Pipeline & Forecasting' }), ['Sales'])
  assert.deepEqual(rolesFor({ category: 'Customer Success' }), ['CSM'])
  assert.deepEqual(rolesFor({ category: 'Platform Enablement' }), ['IT'])
})

test('roles come back in ROLES order however the item spells them', () => {
  const roles = rolesFor({ category: 'Sales', tags: ['platform', 'campaign', 'renewals'] })
  assert.deepEqual(roles, ['IT', 'CSM', 'Sales', 'Marketing'])
  assert.deepEqual([...roles].sort(), [...ROLES].filter((r) => roles.includes(r)).sort())
})

test('categories that name the output, not the reader, are stated outright', () => {
  // "Daily Intelligence" and "Strategic Intelligence" carry no role word at all,
  // which left a fifth of the built-in catalogue reachable under All roles only.
  assert.deepEqual(rolesFor({ category: 'Daily Intelligence' }), ['Sales'])
  assert.deepEqual(rolesFor({ category: 'Strategic Intelligence', tags: ['weekly'] }), ['Sales'])
  // Additive: a stated category still picks up the roles its tags imply.
  assert.deepEqual(rolesFor({ category: 'Customer Success', tags: ['renewals', 'platform'] }), ['IT', 'CSM'])
})

test('keywords match whole words only', () => {
  // 'it' inside "with", 'ae' inside "aggregate", 'cs' inside "docs" — every one
  // of these fired before the matcher used word boundaries, which put most of
  // the catalogue under every role at once.
  assert.deepEqual(rolesFor({ category: 'Digest', tags: ['aggregate', 'with docs'] }), [])
  assert.deepEqual(rolesFor({ category: 'IT Operations' }), ['IT'])
  assert.deepEqual(rolesFor({ tags: ['AE'] }), ['Sales'])
})

test('the description is never read — inferring from prose made the filter meaningless', () => {
  const item = { category: 'Team Cadence', tags: [] }
  assert.deepEqual(rolesFor({ ...item, ...{ description: 'mentions marketing and engineers' } as object }), [])
})

test('an unclassifiable item is reachable under All roles only', () => {
  // "Starters" and "Team Cadence" are audience-neutral by design — everyone's.
  const item = { category: 'Team Cadence' }
  assert.deepEqual(rolesFor(item), [])
  assert.equal(hasRole(item, ALL_ROLES), true)
  for (const role of ROLES) assert.equal(hasRole(item, role), false, `${role} must not claim it`)
})

test('hasRole admits an item under each role it holds', () => {
  const item = { category: 'Account Monitoring', audience: ['CSMs'] }
  assert.equal(hasRole(item, 'CSM'), true)
  assert.equal(hasRole(item, 'Sales'), true)
  assert.equal(hasRole(item, 'Marketing'), false)
})
