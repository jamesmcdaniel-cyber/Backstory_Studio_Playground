import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSlackEvent } from '@/lib/activity/normalize'

const ORG = '00000000-0000-0000-0000-000000000001'
const BOT = 'U0BOT'
const receivedAt = new Date('2026-08-24T12:00:00Z')

const envelope = (event: Record<string, unknown>) => ({
  team_id: 'T1',
  event_id: 'Ev123',
  event: { channel: 'C1', ts: '1750000000.000100', user: 'U9', ...event },
})

test('an app_mention normalizes to agent.mentioned', () => {
  const normalized = normalizeSlackEvent(ORG, envelope({ type: 'app_mention', text: `<@${BOT}> hi` }), {
    botUserId: BOT,
    receivedAt,
  })
  assert.ok(normalized)
  assert.equal(normalized.kind, 'agent.mentioned')
  assert.equal(normalized.actorExternalId, 'U9')
})

test('a mention gets its OWN sourceEventId namespace', () => {
  // Slack delivers the SAME message as both message.channels and app_mention.
  // They share channel and ts, so a shared namespace would collide on
  // @@unique([organizationId, source, sourceEventId]) and the mention would be
  // swallowed as a redelivery of the plain message.
  const message = normalizeSlackEvent(ORG, envelope({ type: 'message', text: `<@${BOT}> hi` }), {
    botUserId: BOT,
    receivedAt,
  })
  const mention = normalizeSlackEvent(ORG, envelope({ type: 'app_mention', text: `<@${BOT}> hi` }), {
    botUserId: BOT,
    receivedAt,
  })
  assert.ok(message && mention)
  assert.equal(message.sourceEventId, 'slack:msg:C1:1750000000.000100')
  assert.equal(mention.sourceEventId, 'slack:mention:C1:1750000000.000100')
  assert.notEqual(message.sourceEventId, mention.sourceEventId)
})

test('a TOP-LEVEL mention has no threadTs, only its own ts', () => {
  // The common case, and the one that would break a dispatcher requiring
  // threadTs: Slack sets thread_ts only on a REPLY. The message's own ts is
  // what a reply must be threaded against to start the thread.
  const normalized = normalizeSlackEvent(ORG, envelope({ type: 'app_mention', text: `<@${BOT}> hi` }), {
    botUserId: BOT,
    receivedAt,
  })
  assert.ok(normalized)
  const subject = normalized.subject as Record<string, unknown>
  assert.equal(subject.threadTs, null)
  assert.equal(subject.ts, '1750000000.000100')
})

test('a mention inside a thread carries the thread root', () => {
  const normalized = normalizeSlackEvent(
    ORG,
    envelope({ type: 'app_mention', text: `<@${BOT}> Scout go`, thread_ts: '1749999999.000001' }),
    { botUserId: BOT, receivedAt },
  )
  assert.ok(normalized)
  const subject = normalized.subject as Record<string, unknown>
  assert.equal(subject.channelId, 'C1')
  assert.equal(subject.threadTs, '1749999999.000001')
  const payload = normalized.payload as Record<string, unknown>
  assert.equal((payload.event as Record<string, unknown>).text, `<@${BOT}> Scout go`)
})

test('a mention the bot itself authored is selfOrigin', () => {
  // The loop guard. An agent's own reply must never be read as a new request.
  const normalized = normalizeSlackEvent(ORG, envelope({ type: 'app_mention', user: BOT }), {
    botUserId: BOT,
    receivedAt,
  })
  assert.ok(normalized)
  assert.equal(normalized.selfOrigin, true)
})

test('a mention carries chain depth back out of the message metadata', () => {
  const normalized = normalizeSlackEvent(
    ORG,
    envelope({
      type: 'app_mention',
      metadata: { event_type: 'flow_message', event_payload: { chainDepth: 2 } },
    }),
    { botUserId: BOT, receivedAt },
  )
  assert.ok(normalized)
  assert.equal(normalized.chainDepth, 2)
})
