import { test } from 'node:test'
import assert from 'node:assert/strict'

import { redactLogMeta, REDACTED } from '../redact'

/**
 * The audit that produced this module found secrets stayed out of logs only by
 * convention: `apiLogger` was a bare console wrapper, so any future
 * `apiLogger.error('refresh failed', { cfg })` would have printed a decrypted
 * refresh token. These tests pin the two independent defences — the key name
 * and the value shape — because either alone misses real cases: a token under
 * `{ data: '...' }` has no telltale key, and a field called `apiKey` may hold a
 * short value no shape rule would flag.
 */

test('redacts values whose key names a secret, whatever the value looks like', () => {
  const out = redactLogMeta({
    accessToken: 'abc',
    refresh_token: 'xyz',
    apiKey: 'k',
    clientSecret: 's',
    password: 'p',
    authorization: 'Basic dXNlcjpwdw==',
    cookie: 'sb-access-token=1',
  }) as Record<string, unknown>

  for (const key of Object.keys(out)) {
    assert.equal(out[key], REDACTED, `${key} should be redacted by name`)
  }
})

test('keeps non-secret fields readable — redaction must not destroy debuggability', () => {
  const out = redactLogMeta({
    organizationId: 'org_123',
    status: 404,
    provider: 'slack',
    retries: 2,
    ok: false,
  }) as Record<string, unknown>

  assert.deepEqual(out, {
    organizationId: 'org_123',
    status: 404,
    provider: 'slack',
    retries: 2,
    ok: false,
  })
})

test('redacts token-shaped values under innocent key names', () => {
  const out = redactLogMeta({
    // No key-name signal at all — only the shape gives these away.
    detail: `Bearer ${['sk', 'ant', 'api03', 'A'.repeat(36)].join('-')}`,
    payload: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl',
    note: `mcp_live_${'A'.repeat(32)}`,
    stored: 'v2:1a2b3c4d:aXY=:dGFn:Y3Q=',
  }) as Record<string, unknown>

  // An embedded credential is cut out of the surrounding text rather than
  // taking the whole line with it — `Bearer [REDACTED]` still says what failed.
  assert.ok(!String(out.detail).includes('api03-AAA'), 'the key itself is gone')
  assert.ok(String(out.detail).includes(REDACTED))
  assert.equal(out.payload, REDACTED)
  assert.equal(out.note, REDACTED)
  assert.equal(out.stored, REDACTED)
})

test('redacts our own ciphertext envelopes — logging one leaks which key is live', () => {
  for (const payload of ['v1:aXY=:dGFn:Y3Q=', 'v2:deadbeef:aXY=:dGFn:Y3Q=', 'b64:c2VjcmV0']) {
    const out = redactLogMeta({ value: payload }) as Record<string, unknown>
    assert.equal(out.value, REDACTED, `${payload} should be redacted`)
  }
})

test('walks nested objects and arrays', () => {
  const out = redactLogMeta({
    connection: { config: { refreshToken: 'live-token', tokenUrl: 'https://example.com/token' } },
    attempts: [{ authorization: 'Bearer abc' }, { status: 500 }],
  }) as Record<string, unknown>

  const connection = out.connection as Record<string, Record<string, unknown>>
  assert.equal(connection.config.refreshToken, REDACTED)
  assert.equal(connection.config.tokenUrl, 'https://example.com/token', 'a URL is not a secret')

  const attempts = out.attempts as Array<Record<string, unknown>>
  assert.equal(attempts[0].authorization, REDACTED)
  assert.equal(attempts[1].status, 500)
})

test('strips credentials out of URLs rather than dropping the whole URL', () => {
  const out = redactLogMeta({
    url: 'https://api.example.com/v1/items?api_key=SUPERSECRETVALUE123456&page=2',
    endpoint: 'https://user:hunter2@api.example.com/hook',
  }) as Record<string, unknown>

  // The host and path are the useful part of a log line; only the secret goes.
  assert.equal(out.url, `https://api.example.com/v1/items?api_key=${REDACTED}&page=2`)
  assert.equal(out.endpoint, `https://${REDACTED}@api.example.com/hook`)
})

test('survives cycles and caps runaway depth instead of throwing', () => {
  const cyclic: Record<string, unknown> = { name: 'root' }
  cyclic.self = cyclic

  const out = redactLogMeta(cyclic) as Record<string, unknown>
  assert.equal(out.name, 'root')
  // The cycle must terminate — the exact marker matters less than not hanging.
  assert.ok(out.self !== undefined)
})

test('redacts Error objects without losing the message shape', () => {
  const error = new Error(`token refresh failed for Bearer ${['sk', 'ant', 'A'.repeat(28)].join('-')}`)
  const out = redactLogMeta({ error }) as Record<string, unknown>
  const rendered = String((out.error as Record<string, unknown>).message)

  assert.ok(rendered.includes('token refresh failed'), 'keeps the human-readable cause')
  assert.ok(!rendered.includes('ant-AAA'), 'drops the embedded token')
})

test('passes through null and undefined meta untouched', () => {
  assert.equal(redactLogMeta(undefined), undefined)
  assert.equal(redactLogMeta(null), null)
})
