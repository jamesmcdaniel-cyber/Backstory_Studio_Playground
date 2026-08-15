import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  assessStaleness,
  CredentialLifetimeError,
  DEFAULT_TOKEN_LIFETIME_DAYS,
  MAX_TOKEN_LIFETIME_DAYS,
  resolveTokenExpiry,
} from '../lifetime'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-08-15T12:00:00.000Z')
const days = (n: number) => new Date(NOW.getTime() + n * DAY_MS)

// ── Mint-time expiry ───────────────────────────────────────────────────────

test('omitting an expiry yields a bounded token, not an unbounded one', () => {
  // The whole point: "no expiry" has to stop being reachable. This was the
  // default before, and it is how a token outlives the person who minted it.
  const expiry = resolveTokenExpiry(undefined, NOW)
  assert.equal(expiry.getTime(), days(DEFAULT_TOKEN_LIFETIME_DAYS).getTime())
})

test('null is treated the same as omitted', () => {
  assert.equal(resolveTokenExpiry(null, NOW).getTime(), days(DEFAULT_TOKEN_LIFETIME_DAYS).getTime())
})

test('an explicit expiry inside the cap is honoured exactly', () => {
  const chosen = days(30)
  assert.equal(resolveTokenExpiry(chosen, NOW).getTime(), chosen.getTime())
})

test('an expiry beyond the cap is REFUSED, not silently shortened', () => {
  // Silently clamping produces a token that dies earlier than its owner planned
  // around — an outage they had no warning of. Refusing puts the choice back
  // with the person making it.
  assert.throws(
    () => resolveTokenExpiry(days(MAX_TOKEN_LIFETIME_DAYS + 1), NOW),
    (error: unknown) => error instanceof CredentialLifetimeError && /at most 365 days/.test((error as Error).message),
  )
})

test('an expiry exactly at the cap is allowed', () => {
  const atCap = days(MAX_TOKEN_LIFETIME_DAYS)
  assert.equal(resolveTokenExpiry(atCap, NOW).getTime(), atCap.getTime())
})

test('an expiry in the past is refused', () => {
  assert.throws(() => resolveTokenExpiry(days(-1), NOW), CredentialLifetimeError)
  assert.throws(() => resolveTokenExpiry(NOW, NOW), CredentialLifetimeError)
})

// ── Staleness ──────────────────────────────────────────────────────────────

test('age is measured from the last rotation, not from creation', () => {
  // A credential rotated last week is fresh however old the row is. Measuring
  // from createdAt would report every well-maintained credential as ancient and
  // train people to ignore the warning.
  const result = assessStaleness({
    createdAt: days(-900),
    lastRotatedAt: days(-3),
    now: NOW,
  })

  assert.equal(result.level, 'fresh')
  assert.equal(result.ageDays, 3)
})

test('a never-rotated credential falls back to its creation date', () => {
  const result = assessStaleness({ createdAt: days(-400), lastRotatedAt: null, now: NOW })
  assert.equal(result.level, 'stale')
  assert.equal(result.ageDays, 400)
})

test('an already-expired credential outranks every other signal', () => {
  const result = assessStaleness({
    createdAt: days(-10),
    lastRotatedAt: days(-1),
    expiresAt: days(-5),
    now: NOW,
  })

  assert.equal(result.level, 'expired')
  assert.match(result.summary, /already failing/)
})

test('impending expiry warns while there is still time to act', () => {
  const result = assessStaleness({
    createdAt: days(-10),
    lastRotatedAt: days(-10),
    expiresAt: days(7),
    now: NOW,
  })

  assert.equal(result.level, 'aging')
  assert.equal(result.expiresInDays, 7)
  assert.match(result.summary, /before anything using it breaks/)
})

test('a credential with no expiry is judged purely on rotation age', () => {
  const fresh = assessStaleness({ createdAt: days(-5), lastRotatedAt: days(-5), now: NOW })
  assert.equal(fresh.level, 'fresh')
  assert.equal(fresh.expiresInDays, null)

  const stale = assessStaleness({ createdAt: days(-800), lastRotatedAt: days(-800), now: NOW })
  assert.equal(stale.level, 'stale')
  assert.match(stale.summary, /over 2 years/)
})

test('a long-lived expiry does not by itself make a credential aging', () => {
  const result = assessStaleness({
    createdAt: days(-5),
    lastRotatedAt: days(-5),
    expiresAt: days(300),
    now: NOW,
  })
  assert.equal(result.level, 'fresh')
})
