import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relativeTime } from '@/lib/relative-time'

const NOW = new Date('2026-08-11T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

test('anything under a minute reads as just now', () => {
  assert.equal(relativeTime(ago(0), NOW), 'just now')
  assert.equal(relativeTime(ago(59 * SECOND), NOW), 'just now')
})

test('minutes up to the hour boundary', () => {
  assert.equal(relativeTime(ago(MINUTE), NOW), '1m ago')
  assert.equal(relativeTime(ago(59 * MINUTE), NOW), '59m ago')
})

test('hours up to the day boundary', () => {
  assert.equal(relativeTime(ago(HOUR), NOW), '1h ago')
  assert.equal(relativeTime(ago(23 * HOUR), NOW), '23h ago')
})

test('days up to a week', () => {
  assert.equal(relativeTime(ago(DAY), NOW), '1d ago')
  assert.equal(relativeTime(ago(6 * DAY), NOW), '6d ago')
})

test('past a week it falls back to an absolute date', () => {
  const older = relativeTime(ago(7 * DAY), NOW)
  assert.ok(!older.includes('ago'), `expected an absolute date, got ${older}`)
  assert.ok(older.includes('4'), `expected Aug 4, got ${older}`)
})

test('unparseable and future timestamps degrade to just now', () => {
  assert.equal(relativeTime('not a date', NOW), 'just now')
  assert.equal(relativeTime('', NOW), 'just now')
  assert.equal(relativeTime(new Date(NOW.getTime() + HOUR).toISOString(), NOW), 'just now')
})
