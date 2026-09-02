import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUnknownConnectionError } from '../connection-recovery'

const nangoError = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } })

test('Nango rejecting an unknown connection is recognised', () => {
  assert.equal(
    isUnknownConnectionError(nangoError(400, { error: { message: "Connection 'old-id' not found" } })),
    true,
  )
})

test('an unknown provider config key is recognised', () => {
  assert.equal(
    isUnknownConnectionError(nangoError(400, { message: 'Unknown provider config key: google-mail' })),
    true,
  )
})

test('a 404 naming the connection is recognised', () => {
  assert.equal(isUnknownConnectionError(nangoError(404, { message: 'connection not found' })), true)
})

// The two bodies below are VERBATIM captures from Nango production
// (2026-09-02), not guesses — the first predicate shipped with guessed
// phrasing and never fired on the real thing.
test("Nango's real dead-connection body is recognised", () => {
  assert.equal(
    isUnknownConnectionError(nangoError(400, { error: { code: 'server_error', message: 'Failed to get connection' } })),
    true,
  )
})

test("Nango's real unknown-provider-config body is recognised", () => {
  assert.equal(
    isUnknownConnectionError(
      nangoError(404, {
        error: {
          code: 'unknown_provider_config',
          message: 'Provider config not found for the given provider config key. Please make sure the provider config exists in the Nango dashboard.',
        },
      }),
    ),
    true,
  )
})

test("the provider's own rejection of our payload is NOT a stale connection", () => {
  assert.equal(
    isUnknownConnectionError(nangoError(400, { error: { message: "Invalid value at 'message.raw'" } })),
    false,
  )
})

test('an auth failure is not a stale connection — resyncing would not help', () => {
  assert.equal(isUnknownConnectionError(nangoError(401, { message: 'connection not found' })), false)
})

test('a server error is not a stale connection', () => {
  assert.equal(isUnknownConnectionError(nangoError(500, { message: 'connection not found' })), false)
})

test('a plain error with no response is not a stale connection', () => {
  assert.equal(isUnknownConnectionError(new Error('socket hang up')), false)
})

// ── withStaleConnectionRecovery ──────────────────────────────────────────────

import { withStaleConnectionRecovery } from '../connection-recovery'

const CONNECTION = { connectionId: 'old-id', providerConfigKey: 'google-mail', scope: 'user' as const }

test('a success needs no recovery and calls exactly once', async () => {
  let calls = 0
  const result = await withStaleConnectionRecovery({
    organizationId: 'org-1',
    providerConfigKeys: ['google-mail'],
    connection: CONNECTION,
    call: async () => {
      calls += 1
      return 'sent'
    },
  })
  assert.equal(result, 'sent')
  assert.equal(calls, 1)
})

test('an unrelated failure passes through without touching the mirror', async () => {
  let calls = 0
  await assert.rejects(
    withStaleConnectionRecovery({
      organizationId: 'org-1',
      providerConfigKeys: ['google-mail'],
      connection: CONNECTION,
      call: async () => {
        calls += 1
        throw nangoError(400, { error: { message: "Invalid value at 'message.raw'" } })
      },
    }),
    /Request failed with status code 400/,
  )
  assert.equal(calls, 1, 'a payload rejection must not trigger a retry')
})

test('when reconciliation cannot run, the ORIGINAL rejection surfaces', async () => {
  // No NANGO_SECRET_KEY in the test env: the reconcile attempt inside the
  // wrapper fails, and the caller must see the original Nango rejection, not
  // a second error about the recovery.
  delete process.env.NANGO_SECRET_KEY
  await assert.rejects(
    withStaleConnectionRecovery({
      organizationId: 'org-1',
      providerConfigKeys: ['google-mail'],
      connection: CONNECTION,
      call: async () => {
        throw nangoError(400, { message: 'Unknown provider config key: google-mail' })
      },
    }),
    /Request failed with status code 400/,
  )
})
