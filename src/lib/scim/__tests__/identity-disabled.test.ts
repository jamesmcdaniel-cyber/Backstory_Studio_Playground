import { test } from 'node:test'
import assert from 'node:assert/strict'
import { identityDisabled } from '../server'

/**
 * Banning is how deactivation is expressed on BOTH paths — the operator
 * console's deactivate action sets ban_duration, and the Supabase dashboard's
 * "Ban user" does the same thing. A banned identity is still returned by the
 * admin listing, so before this rule existed someone revoked in Supabase went
 * on appearing in the platform's user list as an ordinary active account.
 */

const NOW = new Date('2026-08-20T12:00:00.000Z')

test('a live identity is not disabled', () => {
  assert.equal(identityDisabled({}, NOW), false)
  assert.equal(identityDisabled({ banned_until: null }, NOW), false)
})

test('a ban that has not expired disables the identity', () => {
  assert.equal(identityDisabled({ banned_until: '2026-08-20T13:00:00.000Z' }, NOW), true)
  // The console bans for 876000h, which lands a century out.
  assert.equal(identityDisabled({ banned_until: '2126-08-20T12:00:00.000Z' }, NOW), true)
})

test('an expired ban does not', () => {
  // Supabase leaves the stamp behind rather than clearing it, so a past date is
  // an account that WAS banned and is usable again.
  assert.equal(identityDisabled({ banned_until: '2026-08-20T11:59:59.000Z' }, NOW), false)
})

test("'none' is the unban value, never a ban", () => {
  // It is what the WRITE side sends to lift a ban; an echoed request body must
  // not come back around and read as one.
  assert.equal(identityDisabled({ banned_until: 'none' }, NOW), false)
})

test('a soft-deleted identity is disabled regardless of ban state', () => {
  assert.equal(identityDisabled({ deleted_at: '2026-08-19T00:00:00.000Z' }, NOW), true)
})

test('an unparseable stamp counts as banned', () => {
  // The two ways to be wrong are not symmetric. Reading a stamp we cannot parse
  // as "not banned" leaves a revoked account listed and treated as healthy;
  // reading it as banned only hides a row an operator can still reveal.
  assert.equal(identityDisabled({ banned_until: 'not-a-date' }, NOW), true)
})
