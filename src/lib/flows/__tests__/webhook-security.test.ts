import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FLOW_WEBHOOK_MAX_BODY_BYTES, parseWebhookBody, parseWebhookReplayHeaders, webhookPayloadHash } from '../webhook-security'

const headers = (values: Record<string, string>) => new Headers(values)

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
