import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSlackEvent, normalizeNangoForward } from '../normalize'

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
  const activity = normalizeSlackEvent('org-1', envelope)
  assert.ok(activity)
  assert.equal(activity!.source, 'slack')
  assert.equal(activity!.kind, 'message.posted')
  assert.equal(activity!.sourceEventId, 'Ev123')
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
  const activity = normalizeSlackEvent('org-1', envelope)
  assert.ok(activity)
  assert.equal(activity!.selfOrigin, true)
})

test('slack event authored by the workspace\'s own bot user id → selfOrigin: true', () => {
  const envelope = {
    event_id: 'Ev125',
    event: { type: 'message', user: 'UBOT1', channel: 'C200', ts: '1691000000.000100' },
  }
  const activity = normalizeSlackEvent('org-1', envelope, { botUserId: 'UBOT1' })
  assert.ok(activity)
  assert.equal(activity!.selfOrigin, true)
})

test('slack envelope missing event_id falls back to a stable sha256 id', () => {
  const envelope = { event: { type: 'message', user: 'U1', channel: 'C1', ts: '1691000000.000100' } }
  const a = normalizeSlackEvent('org-1', { ...envelope })
  const b = normalizeSlackEvent('org-1', { ...envelope })
  assert.ok(a!.sourceEventId.startsWith('sha256:'))
  assert.equal(a!.sourceEventId, b!.sourceEventId)
})

test('slack envelope with no event returns null', () => {
  assert.equal(normalizeSlackEvent('org-1', {}), null)
  assert.equal(normalizeSlackEvent('org-1', { event: {} }), null)
})

test('nango salesforce record change → record.updated with recordId', () => {
  const activity = normalizeNangoForward('org-1', 'salesforce', {
    id: 'evt-sf-1',
    recordId: '001xx000003DGb2',
    changeType: 'UPDATE',
    sobject: 'Account',
    modifiedById: '005xx000001Sv6',
  })
  assert.ok(activity)
  assert.equal(activity!.source, 'salesforce')
  assert.equal(activity!.kind, 'record.updated')
  assert.equal(activity!.subject.recordId, '001xx000003DGb2')
  assert.equal(activity!.actorExternalId, '005xx000001Sv6')
  assert.equal(activity!.sourceEventId, 'evt-sf-1')
})

test('nango github PR payload → pr.opened', () => {
  const activity = normalizeNangoForward('org-1', 'github', {
    action: 'opened',
    pull_request: { number: 42, merged: false },
    repository: { full_name: 'acme/widgets' },
    sender: { login: 'octocat' },
  })
  assert.ok(activity)
  assert.equal(activity!.source, 'github')
  assert.equal(activity!.kind, 'pr.opened')
  assert.equal(activity!.subject.repo, 'acme/widgets')
  assert.equal(activity!.subject.prNumber, 42)
  assert.equal(activity!.actorExternalId, 'octocat')
})

test('nango unknown provider/shape → generic kind with hash id', () => {
  const a = normalizeNangoForward('org-1', 'some_weird_provider', { foo: 'bar' })
  const b = normalizeNangoForward('org-1', 'some_weird_provider', { foo: 'bar' })
  assert.ok(a)
  assert.equal(a!.kind, 'generic')
  assert.ok(a!.sourceEventId.startsWith('sha256:'))
  assert.equal(a!.sourceEventId, b!.sourceEventId, 'same content ⇒ same hash id')
})

test('oversize payload is capped and carries the truncation marker', () => {
  const big = 'x'.repeat(60_000)
  const activity = normalizeNangoForward('org-1', 'github', {
    id: 'evt-big',
    action: 'opened',
    pull_request: { number: 1 },
    repository: { full_name: 'acme/widgets' },
    stuffing: big,
  })
  assert.ok(activity)
  const payload = activity!.payload as { truncated: boolean; preview: string; originalLength: number }
  assert.equal(payload.truncated, true)
  assert.ok(payload.preview.includes('truncated'))
  assert.ok(payload.originalLength > 50_000)
})

test('missing event id (nango) falls back to sha256 dedupe key', () => {
  const activity = normalizeNangoForward('org-1', 'salesforce', {
    recordId: 'rec-1',
    changeType: 'UPDATE',
  })
  assert.ok(activity)
  assert.ok(activity!.sourceEventId.startsWith('sha256:'))
})
