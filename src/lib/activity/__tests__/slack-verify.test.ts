import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { verifySlackSignature } from '../slack-verify'

const SECRET = 'test-signing-secret'
const NOW = new Date('2026-08-22T12:00:00.000Z')

function sign(timestamp: string, rawBody: string, secret = SECRET): string {
  const base = `v0:${timestamp}:${rawBody}`
  return `v0=${createHmac('sha256', secret).update(base, 'utf8').digest('hex')}`
}

test('valid signature within the window verifies', () => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000))
  const rawBody = JSON.stringify({ type: 'event_callback' })
  const signature = sign(timestamp, rawBody)
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, timestampHeader: timestamp, signatureHeader: signature, rawBody, now: NOW }),
    true,
  )
})

test('bad signature (wrong secret) fails', () => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000))
  const rawBody = JSON.stringify({ type: 'event_callback' })
  const signature = sign(timestamp, rawBody, 'a-different-secret')
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, timestampHeader: timestamp, signatureHeader: signature, rawBody, now: NOW }),
    false,
  )
})

test('bad signature (tampered body) fails', () => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000))
  const rawBody = JSON.stringify({ type: 'event_callback' })
  const signature = sign(timestamp, rawBody)
  assert.equal(
    verifySlackSignature({
      signingSecret: SECRET,
      timestampHeader: timestamp,
      signatureHeader: signature,
      rawBody: JSON.stringify({ type: 'event_callback', tampered: true }),
      now: NOW,
    }),
    false,
  )
})

test('stale timestamp (just over 5 minutes old) fails', () => {
  const staleMs = NOW.getTime() - (5 * 60_000 + 1_000)
  const timestamp = String(Math.floor(staleMs / 1000))
  const rawBody = JSON.stringify({ type: 'event_callback' })
  const signature = sign(timestamp, rawBody)
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, timestampHeader: timestamp, signatureHeader: signature, rawBody, now: NOW }),
    false,
  )
})

test('timestamp exactly at the 5-minute boundary still verifies', () => {
  const boundaryMs = NOW.getTime() - 5 * 60_000
  const timestamp = String(Math.floor(boundaryMs / 1000))
  const rawBody = JSON.stringify({ type: 'event_callback' })
  const signature = sign(timestamp, rawBody)
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, timestampHeader: timestamp, signatureHeader: signature, rawBody, now: NOW }),
    true,
  )
})

test('a timestamp from the future beyond the window fails', () => {
  const futureMs = NOW.getTime() + (5 * 60_000 + 1_000)
  const timestamp = String(Math.floor(futureMs / 1000))
  const rawBody = JSON.stringify({ type: 'event_callback' })
  const signature = sign(timestamp, rawBody)
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, timestampHeader: timestamp, signatureHeader: signature, rawBody, now: NOW }),
    false,
  )
})

test('missing signature header fails', () => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000))
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, timestampHeader: timestamp, signatureHeader: undefined, rawBody: '{}', now: NOW }),
    false,
  )
})

test('missing timestamp header fails', () => {
  const rawBody = '{}'
  const signature = sign('1000', rawBody)
  assert.equal(
    verifySlackSignature({ signingSecret: SECRET, timestampHeader: null, signatureHeader: signature, rawBody, now: NOW }),
    false,
  )
})

test('missing signing secret fails (never throws)', () => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000))
  const rawBody = '{}'
  const signature = sign(timestamp, rawBody)
  assert.doesNotThrow(() => {
    assert.equal(
      verifySlackSignature({ signingSecret: '', timestampHeader: timestamp, signatureHeader: signature, rawBody, now: NOW }),
      false,
    )
  })
})

test('malformed signature header (no v0= prefix) fails without throwing', () => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000))
  assert.doesNotThrow(() => {
    assert.equal(
      verifySlackSignature({ signingSecret: SECRET, timestampHeader: timestamp, signatureHeader: 'not-a-real-signature', rawBody: '{}', now: NOW }),
      false,
    )
  })
})

test('non-hex signature suffix fails without throwing', () => {
  const timestamp = String(Math.floor(NOW.getTime() / 1000))
  assert.doesNotThrow(() => {
    assert.equal(
      verifySlackSignature({ signingSecret: SECRET, timestampHeader: timestamp, signatureHeader: 'v0=not-hex-zzz', rawBody: '{}', now: NOW }),
      false,
    )
  })
})

test('non-numeric timestamp fails without throwing', () => {
  const rawBody = '{}'
  assert.doesNotThrow(() => {
    assert.equal(
      verifySlackSignature({ signingSecret: SECRET, timestampHeader: 'not-a-number', signatureHeader: 'v0=abc', rawBody, now: NOW }),
      false,
    )
  })
})
