import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// The module caches derived keys and warn-state at module scope, so each test
// re-imports a fresh copy after adjusting the environment.
async function freshSecrets() {
  const mod = await import(`../secrets?t=${Date.now()}-${Math.random()}`)
  return mod as typeof import('../secrets')
}

const ORIGINAL_ENV = { ...process.env }

// Next's types mark NODE_ENV readonly; tests legitimately vary it.
function setNodeEnv(value: string) {
  Object.assign(process.env, { NODE_ENV: value })
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

test('production without ENCRYPTION_KEY: encryptSecret throws', async () => {
  delete process.env.ENCRYPTION_KEY
  setNodeEnv('production')
  const { encryptSecret } = await freshSecrets()
  assert.throws(() => encryptSecret('top-secret'), /ENCRYPTION_KEY is required to store secrets/)
})

test('production without ENCRYPTION_KEY: decrypting a b64 legacy payload throws', async () => {
  delete process.env.ENCRYPTION_KEY
  setNodeEnv('production')
  const { decryptSecret } = await freshSecrets()
  // Legacy b64 payloads decode without a key in dev, but production must not
  // silently run in unencrypted mode.
  assert.throws(() => decryptSecret('b64:' + Buffer.from('x').toString('base64')), /ENCRYPTION_KEY is required in production/)
})

test('with ENCRYPTION_KEY set: encrypt/decrypt round-trips', async () => {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const { encryptSecret, decryptSecret } = await freshSecrets()
  const payload = encryptSecret('grn_abc123')
  // v2 — the key-id-prefixed format that makes ENCRYPTION_KEY rotatable.
  // v1 payloads stay readable; see key-rotation.test.ts.
  assert.match(payload, /^v2:[0-9a-f]{8}:/)
  assert.equal(decryptSecret(payload), 'grn_abc123')
})

test('development without ENCRYPTION_KEY: encryptSecret throws rather than storing plaintext', async () => {
  delete process.env.ENCRYPTION_KEY
  setNodeEnv('development')
  const { encryptSecret } = await freshSecrets()
  // A development box writes real credentials to a real database — "not
  // production" says nothing about whether the token is live.
  assert.throws(() => encryptSecret('dev-secret'), /ENCRYPTION_KEY is required to store secrets/)
})

test('test env without ENCRYPTION_KEY: falls back to b64 so fixtures need no key', async () => {
  delete process.env.ENCRYPTION_KEY
  setNodeEnv('test')
  const { encryptSecret, decryptSecret } = await freshSecrets()
  const payload = encryptSecret('fixture-secret')
  assert.match(payload, /^b64:/)
  assert.equal(decryptSecret(payload), 'fixture-secret')
})

test('legacy b64 rows stay readable once a key is configured, so rotation can re-encrypt them', async () => {
  // The row has to be written the way a pre-key process wrote it: no key in
  // the environment at all, so encryptSecret takes the b64 fallback. Without
  // the delete, an ambient ENCRYPTION_KEY (CI sets one) makes this a v2 row
  // under a key the second half of the test then replaces, and the assertion
  // stops being about legacy rows at all.
  delete process.env.ENCRYPTION_KEY
  setNodeEnv('test')
  const { encryptSecret } = await freshSecrets()
  const legacy = encryptSecret('written-before-the-key-existed')
  assert.match(legacy, /^b64:/, 'the fixture must actually be a legacy row')

  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const { decryptSecret } = await freshSecrets()
  assert.equal(decryptSecret(legacy), 'written-before-the-key-existed')
})

// ── authConfig merging across auth types ────────────────────────────────────

test('switching an SSO connection to client credentials drops the stored tokens', async () => {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const { mergeAuthConfig, encryptSecret } = await freshSecrets()

  const ssoConfig = {
    flow: 'authcode',
    clientId: 'old-sso-client',
    clientSecret: encryptSecret('old-sso-secret'),
    tokenEndpoint: 'https://auth.example.com/token',
    accessToken: encryptSecret('at'),
    refreshToken: encryptSecret('rt'),
    expiresAt: 1234,
  }

  const merged = mergeAuthConfig(ssoConfig, {
    authType: 'oauth2',
    flow: 'client_credentials',
    clientId: 'new-client',
    clientSecret: 'new-secret',
  })

  // Without this, mcpConfigFromConnection still sees flow==='authcode' and
  // keeps presenting the stale SSO bearer instead of the new grant.
  for (const key of ['flow', 'accessToken', 'refreshToken', 'tokenEndpoint', 'expiresAt']) {
    assert.equal(key in merged, false, `${key} should be cleared`)
  }
  assert.equal(merged.clientId, 'new-client')
})

test('an SSO re-save without a flow marker keeps its tokens intact', async () => {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const { mergeAuthConfig, encryptSecret } = await freshSecrets()

  const ssoConfig = { flow: 'authcode', accessToken: encryptSecret('at'), clientId: 'c' }
  const merged = mergeAuthConfig(ssoConfig, { authType: 'oauth2' })

  assert.equal(merged.flow, 'authcode')
  assert.equal(merged.accessToken, ssoConfig.accessToken)
})

test('switching between api_key and oauth2 discards the other type\'s credentials', async () => {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const { mergeAuthConfig, encryptSecret } = await freshSecrets()

  const fromApiKey = mergeAuthConfig(
    { apiKey: encryptSecret('sk-legacy'), headerName: 'X-API-Key' },
    { authType: 'oauth2', flow: 'client_credentials', clientId: 'c', clientSecret: 's' },
  )
  assert.equal('apiKey' in fromApiKey, false)
  assert.equal('headerName' in fromApiKey, false)

  const fromOauth = mergeAuthConfig(
    { clientId: 'c', clientSecret: encryptSecret('s'), tokenUrl: 'https://t', scopes: 'read' },
    { authType: 'api_key', apiKey: 'sk-new' },
  )
  for (const key of ['clientId', 'clientSecret', 'tokenUrl', 'scopes']) {
    assert.equal(key in fromOauth, false, `${key} should be cleared`)
  }
})

test('redactConfig surfaces the SSO flow marker but never a secret', async () => {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const { redactConfig, encryptSecret } = await freshSecrets()

  const sso = redactConfig('oauth2', {
    flow: 'authcode',
    clientId: 'c',
    clientSecret: encryptSecret('s'),
    accessToken: encryptSecret('at'),
  })
  assert.equal(sso.flow, 'authcode')
  assert.equal(sso.hasClientSecret, true)
  assert.equal('clientSecret' in sso, false)
  assert.equal('accessToken' in sso, false)

  // Client-credentials connections carry no flow marker — that absence is what
  // the dialog uses to pick the client ID + secret form.
  const clientCreds = redactConfig('oauth2', { clientId: 'c', clientSecret: encryptSecret('s') })
  assert.equal(clientCreds.flow, undefined)
})

// ── Empty plaintext ────────────────────────────────────────────────────────
//
// An OAuth flow legitimately has nothing to store in a secret slot: a PKCE
// public client has no client_secret, and plenty of servers issue no
// refresh_token. Callers wrote `encryptSecret(value || '')` for those, which
// produced a well-formed envelope with an EMPTY ciphertext field — and
// decryptSecret rejected it as malformed, because its emptiness check could not
// tell an absent field from an empty one.
//
// The row was then unreadable forever: every path that decrypts it threw, which
// 500'd the connection-test route and failed every flow step bound to it. So
// empty plaintext must round-trip, while a genuinely truncated payload must
// still be refused.

test('the empty string round-trips — an empty secret is not a malformed one', async () => {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const { encryptSecret, decryptSecret } = await freshSecrets()

  assert.equal(decryptSecret(encryptSecret('')), '')
})

test('a legacy v1 envelope with an empty ciphertext decrypts to the empty string', async () => {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const crypto = await import('node:crypto')
  const { decryptSecret } = await freshSecrets()

  // v1 carried no key id, so build one the way the pre-rotation code did.
  const key = crypto.createHash('sha256').update('unit-test-key').digest()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update('', 'utf8'), cipher.final()])
  const legacy = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':')

  assert.equal(legacy.split(':').length - 1, 3)
  assert.equal(decryptSecret(legacy), '')
})

test('a truncated payload is still refused — only the ciphertext may be empty', async () => {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const { encryptSecret, decryptSecret } = await freshSecrets()

  const [, keyId, iv, tag] = encryptSecret('x').split(':')

  // Missing the ciphertext FIELD (no trailing colon), not an empty one.
  assert.throws(() => decryptSecret(`v2:${keyId}:${iv}:${tag}`), /Malformed v2/)
  assert.throws(() => decryptSecret(`v2:${keyId}:${iv}`), /Malformed v2/)
  assert.throws(() => decryptSecret('v2:'), /Malformed v2/)
  // An empty iv or tag is never legitimate — both are fixed-width random bytes.
  assert.throws(() => decryptSecret(`v2:${keyId}::${tag}:`), /Malformed v2/)
  assert.throws(() => decryptSecret(`v2:${keyId}:${iv}::`), /Malformed v2/)
  assert.throws(() => decryptSecret(`v1:${iv}:${tag}`), /Malformed v1/)
  assert.throws(() => decryptSecret('v1:'), /Malformed v1/)
})

test('an empty ciphertext still fails the auth tag under the wrong key', async () => {
  process.env.ENCRYPTION_KEY = 'unit-test-key'
  setNodeEnv('production')
  const written = await freshSecrets()
  const blob = written.encryptSecret('')

  // A different key must not decrypt it to '' — GCM's tag covers the empty
  // plaintext too, so authentication is not skipped just because there is
  // nothing to decrypt.
  process.env.ENCRYPTION_KEY = 'a-different-key'
  const { decryptSecret } = await freshSecrets()
  assert.throws(() => decryptSecret(blob), /No configured key matches id/)
})
