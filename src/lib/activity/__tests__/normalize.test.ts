import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSlackEvent, normalizeNangoForward, normalizeSlackHistoryMessage } from '../normalize'

const RECEIVED_AT = new Date('2026-08-22T12:00:00.000Z')

test('slack message event → message.posted with channel/threadTs subject', () => {
  const envelope = {
    team_id: 'T123',
    event_id: 'Ev123',
    event: {
      type: 'message',
      user: 'U100',
      channel: 'C200',
      thread_ts: '1691000000.000100',
      ts: '1691000010.000200',
      text: 'hello',
    },
  }
  const activity = normalizeSlackEvent('org-1', envelope, { receivedAt: RECEIVED_AT })
  assert.ok(activity)
  assert.equal(activity!.source, 'slack')
  assert.equal(activity!.kind, 'message.posted')
  // channel+ts wins over event_id — this is the identity live ingestion and
  // backfill (which never has an event_id at all) must agree on to dedupe
  // the same message across both transports. See normalizeSlackEvent's doc.
  assert.equal(activity!.sourceEventId, 'slack:msg:C200:1691000010.000200')
  assert.equal(activity!.subject.channelId, 'C200')
  assert.equal(activity!.subject.threadTs, '1691000000.000100')
  assert.equal(activity!.actorExternalId, 'U100')
  assert.equal(activity!.selfOrigin, false)
  assert.equal(activity!.ownerUserId, null)
  assert.equal(activity!.chainDepth, 0)
  assert.ok(activity!.occurredAt instanceof Date)
})

test('slack bot-authored event (bot_id) → selfOrigin: true', () => {
  const envelope = {
    event_id: 'Ev124',
    event: { type: 'message', bot_id: 'B999', channel: 'C200', ts: '1691000000.000100' },
  }
  const activity = normalizeSlackEvent('org-1', envelope, { receivedAt: RECEIVED_AT })
  assert.ok(activity)
  assert.equal(activity!.selfOrigin, true)
})

test('slack event authored by the workspace\'s own bot user id → selfOrigin: true', () => {
  const envelope = {
    event_id: 'Ev125',
    event: { type: 'message', user: 'UBOT1', channel: 'C200', ts: '1691000000.000100' },
  }
  const activity = normalizeSlackEvent('org-1', envelope, { botUserId: 'UBOT1', receivedAt: RECEIVED_AT })
  assert.ok(activity)
  assert.equal(activity!.selfOrigin, true)
})

test('a message event missing event_id still gets a stable id — derived from channel+ts, not a hash', () => {
  // Every message event carries channel+ts, so this is the COMMON case, not
  // the hash-fallback one — Slack's Events API delivery itself never sets
  // event_id for anything but the outer envelope in some client libraries,
  // and this must still dedupe deterministically without it.
  const envelope = { event: { type: 'message', user: 'U1', channel: 'C1', ts: '1691000000.000100' } }
  const a = normalizeSlackEvent('org-1', { ...envelope }, { receivedAt: RECEIVED_AT })
  const b = normalizeSlackEvent('org-1', { ...envelope }, { receivedAt: RECEIVED_AT })
  assert.equal(a!.sourceEventId, 'slack:msg:C1:1691000000.000100')
  assert.equal(a!.sourceEventId, b!.sourceEventId)
})

test('an event with neither channel+ts nor event_id falls back to a stable sha256 id', () => {
  // channel_created-style events: no channel/ts pair on the event itself
  // (the channel is nested in an object, not a flat string field).
  const envelope = { event: { type: 'channel_created', user: 'U1' } }
  const a = normalizeSlackEvent('org-1', { ...envelope }, { receivedAt: RECEIVED_AT })
  const b = normalizeSlackEvent('org-1', { ...envelope }, { receivedAt: RECEIVED_AT })
  assert.ok(a!.sourceEventId.startsWith('sha256:'))
  assert.equal(a!.sourceEventId, b!.sourceEventId)
})

test('event_id wins over the sha256 fallback when channel+ts are both absent', () => {
  const envelope = { event_id: 'Ev777', event: { type: 'channel_created', user: 'U1' } }
  const activity = normalizeSlackEvent('org-1', envelope, { receivedAt: RECEIVED_AT })
  assert.equal(activity!.sourceEventId, 'Ev777')
})

test('slack envelope with no event returns null', () => {
  assert.equal(normalizeSlackEvent('org-1', {}, { receivedAt: RECEIVED_AT }), null)
  assert.equal(normalizeSlackEvent('org-1', { event: {} }, { receivedAt: RECEIVED_AT }), null)
})

test('slack event with no timestamp anywhere in the payload falls back to the required receivedAt', () => {
  const envelope = { event_id: 'Ev999', event: { type: 'message', user: 'U1', channel: 'C1' } }
  const activity = normalizeSlackEvent('org-1', envelope, { receivedAt: RECEIVED_AT })
  assert.ok(activity)
  assert.equal(activity!.occurredAt.getTime(), RECEIVED_AT.getTime())
})

test('nango salesforce record change → record.updated with recordId', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'salesforce',
    {
      id: 'evt-sf-1',
      recordId: '001xx000003DGb2',
      changeType: 'UPDATE',
      sobject: 'Account',
      modifiedById: '005xx000001Sv6',
    },
    { receivedAt: RECEIVED_AT },
  )
  assert.ok(activity)
  assert.equal(activity!.source, 'salesforce')
  assert.equal(activity!.kind, 'record.updated')
  assert.equal(activity!.subject.recordId, '001xx000003DGb2')
  assert.equal(activity!.actorExternalId, '005xx000001Sv6')
  assert.equal(activity!.sourceEventId, 'evt-sf-1')
})

test('nango salesforce CREATE → record.created', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'salesforce',
    { id: 'evt-sf-2', recordId: 'rec-2', changeType: 'CREATE' },
    { receivedAt: RECEIVED_AT },
  )
  assert.equal(activity!.kind, 'record.created')
})

test('nango salesforce DELETE → record.deleted', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'salesforce',
    { id: 'evt-sf-3', recordId: 'rec-3', changeType: 'DELETE' },
    { receivedAt: RECEIVED_AT },
  )
  assert.equal(activity!.kind, 'record.deleted')
})

test('nango github PR payload → pr.opened', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'github',
    {
      action: 'opened',
      pull_request: { number: 42, merged: false },
      repository: { full_name: 'acme/widgets' },
      sender: { login: 'octocat' },
    },
    { receivedAt: RECEIVED_AT },
  )
  assert.ok(activity)
  assert.equal(activity!.source, 'github')
  assert.equal(activity!.kind, 'pr.opened')
  assert.equal(activity!.subject.repo, 'acme/widgets')
  assert.equal(activity!.subject.prNumber, 42)
  assert.equal(activity!.actorExternalId, 'octocat')
})

test('nango github PR closed-not-merged → pr.closed', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'github',
    { action: 'closed', pull_request: { number: 7, merged: false }, repository: { full_name: 'acme/widgets' } },
    { receivedAt: RECEIVED_AT },
  )
  assert.equal(activity!.kind, 'pr.closed')
})

test('nango github PR closed-and-merged → pr.merged', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'github',
    { action: 'closed', pull_request: { number: 8, merged: true }, repository: { full_name: 'acme/widgets' } },
    { receivedAt: RECEIVED_AT },
  )
  assert.equal(activity!.kind, 'pr.merged')
})

test('nango github issue opened → issue.opened', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'github',
    { action: 'opened', issue: { number: 3 }, repository: { full_name: 'acme/widgets' } },
    { receivedAt: RECEIVED_AT },
  )
  assert.equal(activity!.kind, 'issue.opened')
  assert.equal(activity!.subject.issueNumber, 3)
})

test('nango github issue closed → issue.closed', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'github',
    { action: 'closed', issue: { number: 4 }, repository: { full_name: 'acme/widgets' } },
    { receivedAt: RECEIVED_AT },
  )
  assert.equal(activity!.kind, 'issue.closed')
})

test('nango github push (ref + commits) → push', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'github',
    { ref: 'refs/heads/main', commits: [{ id: 'abc' }], repository: { full_name: 'acme/widgets' } },
    { receivedAt: RECEIVED_AT },
  )
  assert.equal(activity!.kind, 'push')
  assert.equal(activity!.subject.ref, 'refs/heads/main')
})

// Finding 5: a Nango-forwarded Slack message must land as source: 'slack',
// not 'nango:slack', with the SAME channel:ts identity scheme
// normalizeSlackEvent uses — otherwise a slack-trigger flow never matches a
// Nango-plane Slack forward, and the same message ingested through both
// planes would insert as two rows instead of deduping into one.
test('nango slack forward → source: "slack", kind: "message.posted", channel:ts identity mirrors the native plane', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'slack',
    { type: 'message', channel: 'C500', user: 'U900', ts: '1700000000.000100', text: 'hi from nango' },
    { receivedAt: RECEIVED_AT },
  )
  assert.ok(activity)
  assert.equal(activity!.source, 'slack')
  assert.equal(activity!.kind, 'message.posted')
  assert.equal(activity!.sourceEventId, 'slack:msg:C500:1700000000.000100')
  assert.equal(activity!.subject.channelId, 'C500')
  assert.equal(activity!.actorExternalId, 'U900')
})

test('nango slack forward and a native slack event for the SAME message dedupe to the identical sourceEventId', () => {
  const nango = normalizeNangoForward(
    'org-1',
    'slack',
    { channel: 'C700', user: 'U1', ts: '1700000005.000100' },
    { receivedAt: RECEIVED_AT },
  )
  const native = normalizeSlackEvent(
    'org-1',
    { team_id: 'T1', event: { type: 'message', user: 'U1', channel: 'C700', ts: '1700000005.000100' } },
    { receivedAt: RECEIVED_AT },
  )
  assert.ok(nango && native)
  assert.equal(nango!.source, native!.source)
  assert.equal(nango!.sourceEventId, native!.sourceEventId, 'one plane\'s Slack message and the other\'s must collide into one row')
})

test('nango unknown provider/shape → generic kind with hash id', () => {
  const a = normalizeNangoForward('org-1', 'some_weird_provider', { foo: 'bar' }, { receivedAt: RECEIVED_AT })
  const b = normalizeNangoForward('org-1', 'some_weird_provider', { foo: 'bar' }, { receivedAt: RECEIVED_AT })
  assert.ok(a)
  assert.equal(a!.kind, 'generic')
  assert.ok(a!.sourceEventId.startsWith('sha256:'))
  assert.equal(a!.sourceEventId, b!.sourceEventId, 'same content ⇒ same hash id')
})

test('nango forward with a null/undefined provider never throws', () => {
  assert.doesNotThrow(() => normalizeNangoForward('org-1', undefined as unknown as string, { foo: 'bar' }, { receivedAt: RECEIVED_AT }))
  assert.doesNotThrow(() => normalizeNangoForward('org-1', null as unknown as string, { foo: 'bar' }, { receivedAt: RECEIVED_AT }))
  const activity = normalizeNangoForward('org-1', undefined as unknown as string, { foo: 'bar' }, { receivedAt: RECEIVED_AT })
  assert.ok(activity)
  assert.equal(activity!.kind, 'generic')
})

test('oversize payload is capped and carries the truncation marker', () => {
  const big = 'x'.repeat(60_000)
  const activity = normalizeNangoForward(
    'org-1',
    'github',
    {
      id: 'evt-big',
      action: 'opened',
      pull_request: { number: 1 },
      repository: { full_name: 'acme/widgets' },
      stuffing: big,
    },
    { receivedAt: RECEIVED_AT },
  )
  assert.ok(activity)
  const payload = activity!.payload as { truncated: boolean; preview: string; originalLength: number }
  assert.equal(payload.truncated, true)
  assert.ok(payload.preview.includes('truncated'))
  assert.ok(payload.originalLength > 50_000)
})

test('missing event id (nango) falls back to sha256 dedupe key', () => {
  const activity = normalizeNangoForward(
    'org-1',
    'salesforce',
    { recordId: 'rec-1', changeType: 'UPDATE' },
    { receivedAt: RECEIVED_AT },
  )
  assert.ok(activity)
  assert.ok(activity!.sourceEventId.startsWith('sha256:'))
})

test('nango payload with no timestamp anywhere falls back to the required receivedAt', () => {
  const activity = normalizeNangoForward('org-1', 'salesforce', { id: 'evt-x', recordId: 'rec-x' }, { receivedAt: RECEIVED_AT })
  assert.ok(activity)
  assert.equal(activity!.occurredAt.getTime(), RECEIVED_AT.getTime())
})

// ── normalizeSlackHistoryMessage (Task 7 backfill) ──────────────────────────

test('slack history message → message.posted with the fetched channel folded into subject', () => {
  const message = { type: 'message', user: 'U100', text: 'hello', ts: '1691000010.000200' }
  const activity = normalizeSlackHistoryMessage('org-1', message, 'C200', { receivedAt: RECEIVED_AT })
  assert.ok(activity)
  assert.equal(activity!.source, 'slack')
  assert.equal(activity!.kind, 'message.posted')
  assert.equal(activity!.subject.channelId, 'C200')
  assert.equal(activity!.actorExternalId, 'U100')
})

test('slack history message sourceEventId uses the same slack:msg: scheme live ingestion does', () => {
  const message = { type: 'message', user: 'U100', text: 'hello', ts: '1691000010.000200' }
  const activity = normalizeSlackHistoryMessage('org-1', message, 'C200', { receivedAt: RECEIVED_AT })
  assert.ok(activity)
  assert.equal(activity!.sourceEventId, 'slack:msg:C200:1691000010.000200')
})

test('the same message normalized live (envelope) and via backfill (history) produces the SAME sourceEventId', () => {
  const liveEnvelope = { event_id: 'Ev999', event: { type: 'message', user: 'U100', channel: 'C200', ts: '1691000010.000200', text: 'hello' } }
  const historyMessage = { type: 'message', user: 'U100', text: 'hello', ts: '1691000010.000200' }
  const live = normalizeSlackEvent('org-1', liveEnvelope, { receivedAt: RECEIVED_AT })
  const backfilled = normalizeSlackHistoryMessage('org-1', historyMessage, 'C200', { receivedAt: RECEIVED_AT })
  assert.ok(live && backfilled)
  assert.equal(live!.sourceEventId, backfilled!.sourceEventId)
})

test('an edited message (same ts, different text) still dedupes to the same sourceEventId', () => {
  const original = { type: 'message', user: 'U100', text: 'hello', ts: '1691000010.000200' }
  const edited = { type: 'message', user: 'U100', text: 'hello world', ts: '1691000010.000200', edited: { ts: '1691000099.000000' } }
  const a = normalizeSlackHistoryMessage('org-1', original, 'C200', { receivedAt: RECEIVED_AT })
  const b = normalizeSlackHistoryMessage('org-1', edited, 'C200', { receivedAt: RECEIVED_AT })
  assert.ok(a && b)
  assert.equal(a!.sourceEventId, b!.sourceEventId)
})

test('a message with no ts falls back to the hash-based id rather than throwing', () => {
  const message = { type: 'message', user: 'U100', text: 'no timestamp somehow' }
  const activity = normalizeSlackHistoryMessage('org-1', message, 'C200', { receivedAt: RECEIVED_AT })
  assert.ok(activity)
  assert.ok(activity!.sourceEventId.startsWith('sha256:'))
})

test('a self-authored (bot_id) history message is marked selfOrigin', () => {
  const message = { type: 'message', bot_id: 'B999', text: 'automated', ts: '1691000020.000000' }
  const activity = normalizeSlackHistoryMessage('org-1', message, 'C200', { receivedAt: RECEIVED_AT })
  assert.ok(activity)
  assert.equal(activity!.selfOrigin, true)
})
