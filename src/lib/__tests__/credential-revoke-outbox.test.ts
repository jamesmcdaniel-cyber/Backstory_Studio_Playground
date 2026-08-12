import { test } from 'node:test'
import assert from 'node:assert/strict'
import { credentialRevokeOutboxEvent, OUTBOX_TOPIC_CREDENTIAL_REVOKE } from '../outbox'

test('a credential revoke event carries what the drain needs to delete the grant', () => {
  const event = credentialRevokeOutboxEvent({
    organizationId: 'org-1',
    connectionId: 'conn-abc',
    providerConfigKey: 'slack',
    userId: 'user-1',
  })

  assert.equal(event.topic, OUTBOX_TOPIC_CREDENTIAL_REVOKE)
  assert.equal(event.organizationId, 'org-1')
  assert.deepEqual(event.payload, { connectionId: 'conn-abc', providerConfigKey: 'slack', userId: 'user-1' })
})

test('the dedupe key is the connection, so a double revocation enqueues once', () => {
  // Unlike provider events, a revoke HAS a natural idempotency key: deleting the
  // same grant twice is meaningless, and the unique index makes it impossible.
  const first = credentialRevokeOutboxEvent({
    organizationId: 'org-1',
    connectionId: 'conn-abc',
    providerConfigKey: 'slack',
    userId: 'user-1',
  })
  const second = credentialRevokeOutboxEvent({
    organizationId: 'org-1',
    connectionId: 'conn-abc',
    providerConfigKey: 'slack',
    userId: 'user-1',
  })

  assert.equal(first.dedupeKey, second.dedupeKey)
  assert.match(first.dedupeKey, /conn-abc/)
})

test('the aggregate id is the connection id, so a failed row identifies the live grant', () => {
  // On exhaustion the failed outbox row IS the record that a grant is still out
  // there. It has to name the grant.
  const event = credentialRevokeOutboxEvent({
    organizationId: 'org-1',
    connectionId: 'conn-abc',
    providerConfigKey: 'slack',
    userId: 'user-1',
  })

  assert.equal(event.aggregateId, 'conn-abc')
})
