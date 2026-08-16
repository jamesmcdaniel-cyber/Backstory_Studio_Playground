import { test } from 'node:test'
import assert from 'node:assert/strict'

import { detectPiiCategories, normalizeAiEgressPolicy } from '../pii-egress'

/**
 * Two properties carry this module. Detection must be category-level (the
 * audit row says THAT emails crossed, never WHICH — values in the audit log
 * would be a second copy of the PII). And false positives must stay low,
 * because a detector that reports PII on every prompt produces a log nobody
 * reads, which answers no compliance question at all.
 */

test('detects an email address', () => {
  assert.deepEqual(detectPiiCategories('Reach out to jane.doe@acme-corp.com about renewal'), ['email'])
})

test('detects a formatted phone number', () => {
  const found = detectPiiCategories('Call them at +1 415-555-0123 before Friday')
  assert.ok(found.includes('phone'))
})

test('detects a credit card only when it passes Luhn', () => {
  // The Luhn check is what separates a card number from a 16-digit record id —
  // without it, every Salesforce id-dense prompt reports payment data.
  assert.ok(detectPiiCategories('card 4111 1111 1111 1111 on file').includes('credit_card'))
  assert.ok(!detectPiiCategories('record 1234 5678 9012 3456 updated').includes('credit_card'))
})

test('detects an SSN-shaped national id, but not bare 9-digit runs', () => {
  assert.ok(detectPiiCategories('SSN 123-45-6789 provided').includes('national_id'))
  assert.ok(!detectPiiCategories('order 123456789 shipped').includes('national_id'))
})

test('detects an IP address and a street address', () => {
  assert.ok(detectPiiCategories('login from 203.0.113.42').includes('ip_address'))
  assert.ok(detectPiiCategories('ship to 1600 Amphitheatre Parkway... no wait, 42 Main Street').includes('street_address'))
})

test('ordinary sales prose reports nothing', () => {
  // The whole value of the log is that a row MEANS something.
  const clean = detectPiiCategories(
    'Summarize the Q3 pipeline for enterprise accounts and flag deals with no activity in 30 days. ' +
      'Renewal target is 95 percent and the review is on Thursday.',
  )
  assert.deepEqual(clean, [])
})

test('categories are reported once each, not per occurrence', () => {
  const found = detectPiiCategories('a@x.com b@y.com c@z.com')
  assert.deepEqual(found, ['email'])
})

test('a pathological prompt does not stall the scan', () => {
  const huge = 'word '.repeat(100_000) + ' end@example.com'
  const started = Date.now()
  detectPiiCategories(huge)
  assert.ok(Date.now() - started < 2_000, 'bounded scan must stay fast on the hot path')
})

test('the egress policy blocks only on the exact opt-out value', () => {
  // Same reasoning as SSO enforcement: an unrecognised value silently
  // disabling every agent in a workspace is worse than the risk it guards.
  assert.equal(normalizeAiEgressPolicy('blocked'), 'blocked')
  assert.equal(normalizeAiEgressPolicy('allowed'), 'allowed')
  assert.equal(normalizeAiEgressPolicy('BLOCKED'), 'allowed')
  assert.equal(normalizeAiEgressPolicy(null), 'allowed')
  assert.equal(normalizeAiEgressPolicy(undefined), 'allowed')
})
