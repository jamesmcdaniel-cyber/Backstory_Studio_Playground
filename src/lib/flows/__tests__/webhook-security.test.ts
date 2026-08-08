import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  FLOW_WEBHOOK_MAX_BODY_BYTES,
  parseWebhookBody,
  parseWebhookReplayHeaders,
  requireWebhookReplayProtection,
  webhookPayloadHash,
} from '../webhook-security'

const headers = (values: Record<string, string>) => new Headers(values)

const ORIGINAL_ENV = { ...process.env }
beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
})
after(() => {
  process.env = { ...ORIGINAL_ENV }
})

test('replay protection is mandatory in production', () => {
  Object.assign(process.env, { NODE_ENV: 'production' })
  delete process.env.FLOW_WEBHOOK_REQUIRE_REPLAY_PROTECTION
  assert.equal(requireWebhookReplayProtection(), true)
  const parsed = parseWebhookReplayHeaders(headers({}), Date.now())
  assert.match(parsed.error ?? '', /require/i)
  assert.equal(parsed.value, undefined)
})

test('FLOW_WEBHOOK_REQUIRE_REPLAY_PROTECTION=true still enforces the headers', () => {
  Object.assign(process.env, { NODE_ENV: 'production' })
  process.env.FLOW_WEBHOOK_REQUIRE_REPLAY_PROTECTION = 'true'
  assert.equal(requireWebhookReplayProtection(), true)
  assert.match(parseWebhookReplayHeaders(headers({}), Date.now()).error ?? '', /require/i)
})

test('headers are still validated whenever the sender provides them', () => {
  Object.assign(process.env, { NODE_ENV: 'production' })
  delete process.env.FLOW_WEBHOOK_REQUIRE_REPLAY_PROTECTION
  const now = Date.parse('2026-08-02T12:00:00Z')
  // Partial headers are an error even in lax mode — half a replay guard is a bug at the sender.
  assert.match(parseWebhookReplayHeaders(headers({ 'x-trigger-delivery-id': 'evt_1' }), now).error ?? '', /require/i)
  assert.deepEqual(
    parseWebhookReplayHeaders(headers({ 'x-trigger-delivery-id': 'evt_1', 'x-trigger-timestamp': String(now) }), now).value,
    { deliveryId: 'evt_1', timestampMs: now },
  )
})

test('webhook replay headers accept seconds or milliseconds inside the skew window', () => {
  const now = Date.parse('2026-08-02T12:00:00Z')
  assert.deepEqual(parseWebhookReplayHeaders(headers({ 'x-trigger-delivery-id': 'evt_1', 'x-trigger-timestamp': String(now / 1000) }), now).value, {
    deliveryId: 'evt_1', timestampMs: now,
  })
  assert.equal(parseWebhookReplayHeaders(headers({ 'x-trigger-delivery-id': 'evt_2', 'x-trigger-timestamp': String(now) }), now).error, undefined)
})

test('webhook replay headers reject stale, partial, and malformed values', () => {
  const now = Date.parse('2026-08-02T12:00:00Z')
  assert.match(parseWebhookReplayHeaders(headers({ 'x-trigger-delivery-id': 'evt_1' }), now).error ?? '', /require/i)
  assert.match(parseWebhookReplayHeaders(headers({ 'x-trigger-delivery-id': 'bad id', 'x-trigger-timestamp': String(now) }), now).error ?? '', /invalid/i)
  assert.match(parseWebhookReplayHeaders(headers({ 'x-trigger-delivery-id': 'evt_1', 'x-trigger-timestamp': String(now - 600_000) }), now).error ?? '', /five-minute/i)
})

test('webhook bodies are bounded, parsed, and hashed deterministically', () => {
  const bytes = Buffer.from('{"ok":true}')
  assert.deepEqual(parseWebhookBody(bytes, 'application/json'), { ok: true })
  assert.equal(webhookPayloadHash(bytes), webhookPayloadHash(Buffer.from('{"ok":true}')))
  assert.throws(() => parseWebhookBody(Buffer.alloc(FLOW_WEBHOOK_MAX_BODY_BYTES + 1), 'text/plain'), /too large/)
  assert.throws(() => parseWebhookBody(Buffer.from('{broken'), 'application/json'), /valid JSON/)
})
