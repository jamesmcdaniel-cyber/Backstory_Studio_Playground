import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeSlackEvent, normalizeNangoForward } from '../normalize'

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

test('slack envelope missing event_id falls back to a stable sha256 id', () => {
  const envelope = { event: { type: 'message', user: 'U1', channel: 'C1', ts: '1691000000.000100' } }
  const a = normalizeSlackEvent('org-1', { ...envelope }, { receivedAt: RECEIVED_AT })
  const b = normalizeSlackEvent('org-1', { ...envelope }, { receivedAt: RECEIVED_AT })
  assert.ok(a!.sourceEventId.startsWith('sha256:'))
  assert.equal(a!.sourceEventId, b!.sourceEventId)
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
