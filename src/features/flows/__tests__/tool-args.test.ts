import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applySlackThreadDefault, applySlackChainDepthMetadata, prepareToolArgs } from '../tool-args'
import { normalizeSlackEvent } from '@/lib/activity/normalize'

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

// Chain-depth producer (finding 4, ruling 3 of the design doc): a flow run
// started from an activity/slack trigger stamps its own chainDepth into
// chat.postMessage's `metadata` field on both posting planes, so the
// receiver can cap a Slack-mediated reply loop the same way selfOrigin caps
// a bot-replying-to-itself loop.
test('applySlackChainDepthMetadata: stamps metadata on both slack tool names when the trigger carries a chainDepth', () => {
  const trigger = { type: 'activity', chainDepth: 2, subject: {} }
  const nango = applySlackChainDepthMetadata('slack_post_message', { channel: 'C1', text: 'hi' }, trigger)
  assert.deepEqual(nango.metadata, { event_type: 'flow_message', event_payload: { chainDepth: 2 } })
  const native = applySlackChainDepthMetadata('post_message', { channel: 'C1', text: 'hi' }, trigger)
  assert.deepEqual(native.metadata, { event_type: 'flow_message', event_payload: { chainDepth: 2 } })
})

test('applySlackChainDepthMetadata: omits metadata entirely when the trigger carries no chainDepth (manual/schedule/webhook runs)', () => {
  const result = applySlackChainDepthMetadata('slack_post_message', { channel: 'C1', text: 'hi' }, { type: 'manual' })
  assert.equal('metadata' in result, false)
  assert.deepEqual(result, { channel: 'C1', text: 'hi' })
})

test('applySlackChainDepthMetadata: no-op for non-Slack tools, and never overrides an explicit metadata already on the step', () => {
  const trigger = { type: 'activity', chainDepth: 1 }
  assert.deepEqual(applySlackChainDepthMetadata('gmail_send_email', { to: 'a@b.com' }, trigger), { to: 'a@b.com' })
  const explicit = applySlackChainDepthMetadata('slack_post_message', { channel: 'C1', text: 'hi', metadata: { custom: true } }, trigger)
  assert.deepEqual(explicit.metadata, { custom: true })
})

test('producer/consumer agree end to end: a stamped post normalizes back into the SAME chainDepth', () => {
  const trigger = { type: 'activity', chainDepth: 2 }
  const args = applySlackChainDepthMetadata('slack_post_message', { channel: 'C1', text: 'reply' }, trigger)
  // Slack's Events API echoes a posted message's own metadata back on the
  // resulting event_callback — simulate that envelope shape.
  const envelope = {
    team_id: 'T1',
    type: 'event_callback',
    event: { type: 'message', channel: 'C1', user: 'U_BOT', ts: '1700000001.000100', metadata: args.metadata },
  }
  const normalized = normalizeSlackEvent('org1', envelope, { botUserId: 'U_BOT', receivedAt: new Date() })
  assert.ok(normalized)
  // chainDepthFromMetadata reads it straight back — same depth the posting
  // run itself carried, ready for dispatchActivityEvent to increment once
  // more (event.chainDepth + 1) for whatever run fires next.
  assert.equal(normalized!.chainDepth, 2)
})
