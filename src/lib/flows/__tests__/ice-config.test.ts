import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setErrorReporter, resetErrorReporter } from '@/lib/observability/sentry'
import {
  iceServersFromEnv,
  parseCloudflareIceServers,
  resolveIceServers,
  CLOUDFLARE_TURN_TTL_SECONDS,
} from '../ice-config'

test('STUN always present; TURN appended only with full config', () => {
  assert.deepEqual(iceServersFromEnv({}), [{ urls: 'stun:stun.l.google.com:19302' }])
  assert.deepEqual(
    iceServersFromEnv({ TURN_URL: 'turn:relay.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' }),
    [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'c' },
    ],
  )
})

test('partial TURN config stays STUN-only; comma list becomes an array', () => {
  assert.deepEqual(iceServersFromEnv({ TURN_URL: 'turn:x', TURN_USERNAME: 'u' }), [
    { urls: 'stun:stun.l.google.com:19302' },
  ])
  const out = iceServersFromEnv({ TURN_URL: 'turn:a, turns:b', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' })
  assert.deepEqual(out[1].urls, ['turn:a', 'turns:b'])
})

const CF_ENV = { CLOUDFLARE_TURN_KEY_ID: 'key-1', CLOUDFLARE_TURN_API_TOKEN: 'token-1' }
const CF_BODY = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478'] },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
  ],
}

const okFetch = (body: unknown, calls: unknown[] = []) =>
  (async (url: unknown, init: unknown) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  }) as unknown as typeof fetch

test('parseCloudflareIceServers keeps well-formed entries and rejects junk', () => {
  assert.deepEqual(parseCloudflareIceServers(CF_BODY), CF_BODY.iceServers)
  assert.equal(parseCloudflareIceServers(null), null)
  assert.equal(parseCloudflareIceServers({}), null)
  assert.equal(parseCloudflareIceServers({ iceServers: [] }), null)
  assert.equal(parseCloudflareIceServers({ iceServers: [{ nope: 1 }] }), null)
})

test('Cloudflare config is used and the request carries key, token, ttl and identifier', async () => {
  const calls: unknown[] = []
  const servers = await resolveIceServers(CF_ENV, {
    customIdentifier: 'org-42',
    fetchImpl: okFetch(CF_BODY, calls),
  })
  assert.deepEqual(servers, CF_BODY.iceServers)
  const call = calls[0] as { url: string; init: { headers: Record<string, string>; body: string } }
  assert.match(call.url, /\/v1\/turn\/keys\/key-1\/credentials\/generate-ice-servers$/)
  assert.equal(call.init.headers.Authorization, 'Bearer token-1')
  assert.deepEqual(JSON.parse(call.init.body), {
    ttl: CLOUDFLARE_TURN_TTL_SECONDS,
    customIdentifier: 'org-42',
  })
})

test('a failing Cloudflare call falls through to static TURN env', async () => {
  setErrorReporter(() => {})
  const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch
  const servers = await resolveIceServers(
    { ...CF_ENV, TURN_URL: 'turn:relay.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' },
    { fetchImpl: failing },
  )
  assert.deepEqual(servers, [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'c' },
  ])
  resetErrorReporter()
})

test('a throwing Cloudflare call with no static env degrades to STUN-only', async () => {
  setErrorReporter(() => {})
  const throwing = (async () => { throw new Error('network down') }) as unknown as typeof fetch
  assert.deepEqual(await resolveIceServers(CF_ENV, { fetchImpl: throwing }), [
    { urls: 'stun:stun.l.google.com:19302' },
  ])
  resetErrorReporter()
})

test('without Cloudflare env the relay is never called', async () => {
  let called = false
  const spy = (async () => { called = true; return {} as Response }) as unknown as typeof fetch
  const servers = await resolveIceServers({}, { fetchImpl: spy })
  assert.equal(called, false)
  assert.deepEqual(servers, [{ urls: 'stun:stun.l.google.com:19302' }])
})

test('turnRestCredentials: coturn use-auth-secret shape — expiry username, HMAC-SHA1 base64 credential', async () => {
  const { turnRestCredentials } = await import('@/lib/flows/ice-config')
  const { createHmac } = await import('crypto')
  const nowMs = 1_700_000_000_000
  const { username, credential } = turnRestCredentials('s3cret', nowMs, { ttlSeconds: 600, identifier: 'org-1' })
  assert.equal(username, `${1_700_000_000 + 600}:org-1`)
  assert.equal(credential, createHmac('sha1', 's3cret').update(username).digest('base64'))
  // No identifier → bare expiry timestamp.
  assert.equal(turnRestCredentials('s3cret', nowMs, { ttlSeconds: 600 }).username, String(1_700_000_000 + 600))
})

test('TURN_URL + TURN_SECRET mints ephemeral creds and beats the static pair', async () => {
  const { resolveIceServers, turnRestCredentials } = await import('@/lib/flows/ice-config')
  const nowMs = 1_700_000_000_000
  const servers = await resolveIceServers(
    { TURN_URL: 'turn:relay.example.com:3478', TURN_SECRET: 'shh', TURN_USERNAME: 'static-u', TURN_CREDENTIAL: 'static-c' },
    { customIdentifier: 'org-9', nowMs },
  )
  const expected = turnRestCredentials('shh', nowMs, { identifier: 'org-9' })
  assert.deepEqual(servers, [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:relay.example.com:3478', username: expected.username, credential: expected.credential },
  ])
})

test('TURN_SECRET without TURN_URL changes nothing (half-configured relay is ignored)', async () => {
  const { resolveIceServers } = await import('@/lib/flows/ice-config')
  assert.deepEqual(await resolveIceServers({ TURN_SECRET: 'shh' }), [{ urls: 'stun:stun.l.google.com:19302' }])
})
