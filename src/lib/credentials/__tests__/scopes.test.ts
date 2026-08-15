import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyScope, reviewScopes, SCOPE_POLICY, scopeViolationMessage } from '../scopes'

/**
 * The design these pin: enforcement applies ONLY to providers we have actually
 * written a policy for, and monitoring applies to everything. Getting that
 * backwards in either direction is the failure — blocking on an incomplete
 * scope catalogue breaks working integrations, and flagging nothing for
 * unknown providers reproduces the gap this replaced.
 */

test('write-shaped scopes are classified as write across provider spellings', () => {
  for (const scope of ['chat:write', 'files.write', 'Mail.Send', 'admin:org', 'repo:create', 'full_access']) {
    assert.equal(classifyScope(scope), 'write', `${scope} should read as write access`)
  }
})

test('read and identity scopes are not mistaken for write', () => {
  assert.equal(classifyScope('channels:read'), 'read')
  assert.equal(classifyScope('user.profile:read'), 'read')
  assert.equal(classifyScope('openid'), 'identity')
  assert.equal(classifyScope('offline_access'), 'identity')
})

test('a provider with no declared policy is monitored, never blocked', () => {
  const review = reviewScopes('some_new_saas', ['files:read', 'files:write'])

  assert.equal(review.policyDeclared, false)
  assert.equal(review.permitted, true, 'an uncatalogued provider must not be refused')
  assert.deepEqual(review.excessScopes, [], 'excess is meaningless without a policy')
  // But the write scope still surfaces — this is the whole point of the
  // heuristic firing for providers we have not catalogued.
  assert.deepEqual(review.writeScopes, ['files:write'])
  assert.equal(review.needsReview, true)
})

test('a provider WITH a declared policy refuses scopes beyond it', () => {
  const review = reviewScopes('people_ai', ['mcp:read', 'mcp:tools', 'crm:write'])

  assert.equal(review.policyDeclared, true)
  assert.deepEqual(review.excessScopes, ['crm:write'])
  assert.equal(review.permitted, false, 'a declared policy is enforced')
  assert.equal(review.needsReview, true)
})

test('a grant inside its declared policy is permitted and needs no review', () => {
  const review = reviewScopes('people_ai', ['mcp:read', 'mcp:tools', 'offline_access'])

  assert.equal(review.permitted, true)
  assert.deepEqual(review.excessScopes, [])
  assert.deepEqual(review.writeScopes, [])
  assert.equal(review.needsReview, false)
})

test('a permitted grant can still need review when it carries write access', () => {
  // The two questions are independent: policy asks "is this allowed", the
  // heuristic asks "should someone look". Collapsing them would hide write
  // access that policy happens to permit.
  const review = reviewScopes('some_new_saas', ['messages:send'])
  assert.equal(review.permitted, true)
  assert.equal(review.needsReview, true)
})

test('scopes are normalised and de-duplicated so equal grants compare equal', () => {
  assert.deepEqual(reviewScopes('x', ['b', 'a', 'a', ' b ']).granted, ['a', 'b'])
})

test('an absent provider is treated as having no policy rather than throwing', () => {
  const review = reviewScopes(null, ['anything'])
  assert.equal(review.policyDeclared, false)
  assert.equal(review.permitted, true)
})

test('the violation message names the offending scopes, not just that there were some', () => {
  const review = reviewScopes('people_ai', ['crm:write'])
  const message = scopeViolationMessage('people_ai', review)

  assert.ok(message.includes('crm:write'), 'the person reconnecting must know which scope to drop')
  assert.ok(message.includes(SCOPE_POLICY.people_ai.allowed[0]))
})

test('every declared policy allows at least its own minimum', () => {
  // A policy whose minimum is not inside its allowed set would refuse the
  // integration it exists to permit — a contradiction worth catching at build
  // time rather than at a customer's connect attempt.
  for (const [provider, policy] of Object.entries(SCOPE_POLICY)) {
    for (const scope of policy.minimum) {
      assert.ok(
        policy.allowed.includes(scope),
        `${provider}: minimum scope ${scope} is missing from allowed`,
      )
    }
    assert.ok(policy.rationale.length > 20, `${provider}: policy needs a real rationale`)
  }
})
