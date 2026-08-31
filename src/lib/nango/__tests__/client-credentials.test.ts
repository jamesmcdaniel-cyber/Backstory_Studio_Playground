import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { nangoApiKey, nangoWebhookSigningKey, nangoConfigured, getNangoClient } from '../client'

/**
 * Nango split its single environment secret into an API key (scoped, for API
 * calls) and a webhook signing key. Environments issued only the new pair have
 * no "secret key" at all, so the old single-var wiring could not authenticate
 * them — while deployments still on the legacy secret must keep working
 * untouched. Both models resolve here.
 */

const VARS = ['NANGO_API_KEY', 'NANGO_WEBHOOK_SIGNING_KEY', 'NANGO_SECRET_KEY'] as const
const saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]))

function setEnv(values: Partial<Record<(typeof VARS)[number], string>>) {
  for (const v of VARS) delete process.env[v]
  for (const [k, value] of Object.entries(values)) process.env[k] = value
}

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v] as string
  }
})

test('the new split credentials are used as-is', () => {
  setEnv({ NANGO_API_KEY: 'api-key', NANGO_WEBHOOK_SIGNING_KEY: 'signing-key' })
  assert.equal(nangoApiKey(), 'api-key')
  assert.equal(nangoWebhookSigningKey(), 'signing-key')
  assert.equal(nangoConfigured(), true)
})

test('the legacy single secret still serves BOTH roles', () => {
  // The old key signed webhooks as well as authorizing calls. An existing
  // deployment that sets only this must keep verifying webhooks.
  setEnv({ NANGO_SECRET_KEY: 'legacy' })
  assert.equal(nangoApiKey(), 'legacy')
  assert.equal(nangoWebhookSigningKey(), 'legacy')
  assert.equal(nangoConfigured(), true)
})

test('the new names win over the legacy secret when both are present', () => {
  setEnv({ NANGO_API_KEY: 'api-key', NANGO_WEBHOOK_SIGNING_KEY: 'signing-key', NANGO_SECRET_KEY: 'legacy' })
  assert.equal(nangoApiKey(), 'api-key')
  assert.equal(nangoWebhookSigningKey(), 'signing-key')
})

test('an API key with no signing key still builds a client', () => {
  // Nango never signs with the API key, so webhooks will not verify — but the
  // API half must not be taken down with it.
  setEnv({ NANGO_API_KEY: 'api-key' })
  assert.equal(nangoWebhookSigningKey(), undefined)
  assert.doesNotThrow(() => getNangoClient())
})

test('no credentials at all is a typed 503, not a generic crash', () => {
  setEnv({})
  assert.equal(nangoConfigured(), false)
  assert.throws(() => getNangoClient(), (error: any) => error?.status === 503 && error?.code === 'NANGO_UNAVAILABLE')
})

test('the client never passes apiKey and secretKey together', () => {
  // The SDK constructor throws outright if both are set; the legacy fallback
  // has to map onto apiKey, not reintroduce the deprecated field.
  setEnv({ NANGO_SECRET_KEY: 'legacy' })
  assert.doesNotThrow(() => getNangoClient())
})
