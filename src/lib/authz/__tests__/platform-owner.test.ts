import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPlatformOwnerEmail, PLATFORM_OWNER_EMAILS } from '../platform-owner'

test('exactly two owner identities, both James McDaniel addresses', () => {
  assert.deepEqual(
    [...PLATFORM_OWNER_EMAILS].sort(),
    ['james.mcdaniel@backstory.ai', 'james.mcdaniel@people.ai'],
  )
})

test('matching is case-insensitive and trims whitespace', () => {
  assert.ok(isPlatformOwnerEmail('james.mcdaniel@people.ai'))
  assert.ok(isPlatformOwnerEmail('James.McDaniel@People.ai'))
  assert.ok(isPlatformOwnerEmail('  james.mcdaniel@backstory.ai  '))
})

test('lookalikes and non-values do not match', () => {
  assert.ok(!isPlatformOwnerEmail('james.mcdaniel@peopleai.com'))
  assert.ok(!isPlatformOwnerEmail('james.mcdaniel@people.ai.evil.com'))
  assert.ok(!isPlatformOwnerEmail('xjames.mcdaniel@people.ai'))
  assert.ok(!isPlatformOwnerEmail('someone.else@backstory.ai'))
  assert.ok(!isPlatformOwnerEmail(''))
  assert.ok(!isPlatformOwnerEmail(null))
  assert.ok(!isPlatformOwnerEmail(undefined))
})
