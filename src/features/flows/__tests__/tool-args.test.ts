import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySlackThreadDefault, prepareToolArgs } from '../tool-args'

test('prepareToolArgs accepts objects and JSON object strings', () => {
  assert.deepEqual(prepareToolArgs({ account: 'Acme' }), { account: 'Acme' })
  assert.deepEqual(prepareToolArgs('{"account":"Acme"}'), { account: 'Acme' })
  assert.deepEqual(prepareToolArgs(undefined), {})
})

test('prepareToolArgs rejects invalid JSON and non-object JSON values', () => {
  assert.throws(() => prepareToolArgs('{bad'), /not valid JSON/)
  assert.throws(() => prepareToolArgs('[]'), /JSON object/)
  assert.throws(() => prepareToolArgs('"text"'), /JSON object/)
  assert.throws(() => prepareToolArgs(['not', 'object']), /JSON object/)
})

test('applySlackThreadDefault: defaults thread_ts to the trigger subject when unset', () => {
  const trigger = { type: 'slack', subject: { channelId: 'C1', threadTs: '111.222' } }
  assert.deepEqual(applySlackThreadDefault('slack_post_message', { channel: 'C1', text: 'hi' }, trigger), {
    channel: 'C1',
    text: 'hi',
    thread_ts: '111.222',
  })
})

test('applySlackThreadDefault: falls back to the triggering message\'s own ts for a top-level channel post', () => {
  const trigger = { type: 'activity', subject: { channelId: 'C1', threadTs: null, ts: '999.001' } }
  const result = applySlackThreadDefault('slack_post_message', { channel: 'C1', text: 'hi' }, trigger)
  assert.equal(result.thread_ts, '999.001')
})

test('applySlackThreadDefault: an explicit step thread_ts always wins over the trigger default', () => {
  const trigger = { type: 'slack', subject: { channelId: 'C1', threadTs: '111.222' } }
  const result = applySlackThreadDefault('slack_post_message', { channel: 'C1', text: 'hi', thread_ts: '333.444' }, trigger)
  assert.equal(result.thread_ts, '333.444')
})

test('applySlackThreadDefault: no-op for other tools, and when the trigger carries no subject', () => {
  assert.deepEqual(applySlackThreadDefault('gmail_send_email', { to: 'a@b.com' }, { type: 'slack', subject: { threadTs: 'x' } }), { to: 'a@b.com' })
  assert.deepEqual(applySlackThreadDefault('slack_post_message', { channel: 'C1', text: 'hi' }, { type: 'manual' }), { channel: 'C1', text: 'hi' })
  assert.deepEqual(applySlackThreadDefault('slack_post_message', { channel: 'C1', text: 'hi' }, undefined), { channel: 'C1', text: 'hi' })
})
