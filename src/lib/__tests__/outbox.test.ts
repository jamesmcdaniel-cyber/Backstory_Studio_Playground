import test from 'node:test'
import assert from 'node:assert/strict'
import { flowSignalOutboxEvent, providerSignalOutboxEvent, activityDispatchOutboxEvent, outboxRetryDelayMs } from '../outbox'

test('outbox retry delay backs off exponentially and caps at one hour', () => {
  assert.equal(outboxRetryDelayMs(1), 1_000)
  assert.equal(outboxRetryDelayMs(4), 8_000)
  assert.equal(outboxRetryDelayMs(99), 3_600_000)
})

test('flow signal outbox rows are tenant scoped and deduplicated', () => {
  const event = flowSignalOutboxEvent({
    organizationId: 'org-1',
    aggregateId: 'run-1',
    dedupeKey: 'flow:run-1:succeeded',
    signal: { signal: 'flow.completed', payload: { ok: true }, depth: 1 },
  })
  assert.equal(event.organizationId, 'org-1')
  assert.equal(event.dedupeKey, 'flow:run-1:succeeded')
  assert.deepEqual(event.payload, { signal: 'flow.completed', payload: { ok: true }, depth: 1 })
})

test('nango provider events shape into durable provider.<app> flow signals', () => {
  const event = providerSignalOutboxEvent({
    organizationId: 'org-1',
    connectionId: 'conn-9',
    providerConfigKey: 'salesforce',
    event: 'sync',
    model: 'Contact',
    records: [{ id: 1 }],
    source: 'salesforce',
    sourceEventId: 'evt-1',
  })
  assert.equal(event.organizationId, 'org-1')
  assert.equal(event.topic, 'flow.signal')
  assert.equal(event.aggregateId, 'conn-9')
  assert.equal(
    event.dedupeKey,
    'activity:salesforce:evt-1',
    'dedupeKey reuses the ActivityEvent unique key so redelivery of the same event never double-emits the signal',
  )
  assert.deepEqual(event.payload, {
    signal: 'provider.salesforce',
    payload: { provider: 'salesforce', connectionId: 'conn-9', event: 'sync', model: 'Contact', records: [{ id: 1 }] },
  })
})

test('activity-dispatch outbox rows carry the activity.dispatch topic and dedupe by [source, sourceEventId]', () => {
  const event = activityDispatchOutboxEvent({
    organizationId: 'org-1',
    activityEventId: 'evt-uuid-1',
    source: 'slack',
    sourceEventId: 'Ev0123',
  })
  assert.equal(event.organizationId, 'org-1')
  assert.equal(event.topic, 'activity.dispatch')
  assert.equal(event.aggregateId, 'evt-uuid-1')
  assert.equal(event.dedupeKey, 'activity-dispatch:slack:Ev0123')
  assert.deepEqual(event.payload, { activityEventId: 'evt-uuid-1', source: 'slack', sourceEventId: 'Ev0123' })
})
