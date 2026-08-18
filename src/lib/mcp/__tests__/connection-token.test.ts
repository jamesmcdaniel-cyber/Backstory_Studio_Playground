import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureFreshConnectionToken } from '@/lib/mcp/connection-token'
import { encryptSecret } from '@/lib/crypto/secrets'

/**
 * The pre-run token freshener. Its contract is unusually strict: it must NEVER
 * throw (an agent run would abort) and must return the connection unchanged
 * whenever it cannot produce a better one.
 *
 * Everything below stops before the database write, so no test here needs a
 * live Postgres; the persistence half is marked skipped at the bottom.
 */

process.env.ENCRYPTION_KEY ||= 'connection-token-test-key-0123456789'

const TOKEN_URL = 'https://idp.example.com/token'

function stubFetch(handler: () => Response | Promise<Response>) {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    return handler()
  }) as typeof fetch
  return { count: () => calls, restore: () => { globalThis.fetch = original } }
}

const authcodeConn = (overrides: Record<string, unknown> = {}) => ({
  id: `conn-${Math.random().toString(36).slice(2)}`,
  authType: 'oauth2',
  serverUrl: 'https://mcp.example.com/mcp',
  authConfig: {
    flow: 'authcode',
    clientId: 'cid',
    tokenEndpoint: TOKEN_URL,
    accessToken: encryptSecret('at-stored'),
    refreshToken: encryptSecret('rt-stored'),
    expiresAt: Date.now() + 600_000,
    ...overrides,
  },
})

// ── fast paths: nothing to refresh ────────────────────────────────────────────

test('a connection that is not oauth2 is returned untouched', async () => {
  const { count, restore } = stubFetch(() => new Response('{}', { status: 200 }))
  try {
    for (const authType of ['none', 'api_key', 'basic', '']) {
      const conn = { id: 'c1', authType, authConfig: { flow: 'authcode', refreshToken: 'x' } }
      assert.equal(await ensureFreshConnectionToken(conn), conn, authType)
    }
    assert.equal(count(), 0, 'a non-oauth2 connection must never reach the token endpoint')
  } finally {
    restore()
  }
})

test('an oauth2 connection that is not an authcode flow is returned untouched', async () => {
  const { count, restore } = stubFetch(() => new Response('{}', { status: 200 }))
  try {
    // Client-credentials connections refresh inside the client, not here.
    const cc = { id: 'c2', authType: 'oauth2', authConfig: { clientId: 'cid', tokenUrl: TOKEN_URL } }
    assert.equal(await ensureFreshConnectionToken(cc), cc)
    for (const authConfig of [null, undefined, 'string', ['a'], 42]) {
      const conn = { id: 'c3', authType: 'oauth2', authConfig }
      assert.equal(await ensureFreshConnectionToken(conn), conn, JSON.stringify(authConfig))
    }
    assert.equal(count(), 0)
  } finally {
    restore()
  }
})

test('a still-valid access token is left alone', async () => {
  const { count, restore } = stubFetch(() => new Response('{}', { status: 200 }))
  try {
    const conn = authcodeConn({ expiresAt: Date.now() + 600_000 })
    assert.equal(await ensureFreshConnectionToken(conn), conn)
    assert.equal(count(), 0)
  } finally {
    restore()
  }
})

test('a token inside the 60-second safety margin is treated as expired', async () => {
  const { count, restore } = stubFetch(() => new Response('nope', { status: 400 }))
  try {
    const conn = authcodeConn({ expiresAt: Date.now() + 30_000 })
    // The refresh is attempted (and fails harmlessly below), which is the point.
    assert.equal(await ensureFreshConnectionToken(conn), conn)
    assert.equal(count(), 1, 'a token about to expire must be refreshed, not used')
  } finally {
    restore()
  }
})

// ── degradation: never throw, always hand back something usable ───────────────

test('an expired connection missing its client id or token endpoint degrades quietly', async () => {
  const { count, restore } = stubFetch(() => new Response('{}', { status: 200 }))
  try {
    for (const missing of [{ clientId: undefined }, { tokenEndpoint: undefined }, { clientId: '', tokenEndpoint: '' }]) {
      const conn = authcodeConn({ expiresAt: 0, ...missing })
      assert.equal(await ensureFreshConnectionToken(conn), conn, JSON.stringify(missing))
    }
    assert.equal(count(), 0, 'an unrefreshable connection must not call the token endpoint')
  } finally {
    restore()
  }
})

test('an expired connection with no stored refresh token degrades quietly', async () => {
  const { count, restore } = stubFetch(() => new Response('{}', { status: 200 }))
  try {
    const conn = authcodeConn({ expiresAt: 0, refreshToken: undefined })
    assert.equal(await ensureFreshConnectionToken(conn), conn)
    assert.equal(count(), 0)
  } finally {
    restore()
  }
})

test('an undecryptable refresh token degrades quietly rather than aborting the run', async () => {
  const { count, restore } = stubFetch(() => new Response('{}', { status: 200 }))
  try {
    const conn = authcodeConn({ expiresAt: 0, refreshToken: 'v2:unknown-key:not:valid:ciphertext' })
    assert.equal(await ensureFreshConnectionToken(conn), conn)
    assert.equal(count(), 0)
  } finally {
    restore()
  }
})

test('a rejected refresh returns the original connection instead of throwing', async () => {
  const { count, restore } = stubFetch(() => new Response('{"error":"invalid_grant"}', { status: 400 }))
  try {
    const conn = authcodeConn({ expiresAt: 0 })
    const result = await ensureFreshConnectionToken(conn)
    assert.equal(result, conn)
    assert.equal(count(), 1)
  } finally {
    restore()
  }
})

test('a network failure at the token endpoint is swallowed', async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
  try {
    const conn = authcodeConn({ expiresAt: 0 })
    assert.equal(await ensureFreshConnectionToken(conn), conn)
  } finally {
    globalThis.fetch = original
  }
})

test('a stored access token that will not decrypt still attempts a refresh', async () => {
  const { count, restore } = stubFetch(() => new Response('nope', { status: 500 }))
  try {
    const conn = authcodeConn({ accessToken: 'garbage-not-a-payload', expiresAt: Date.now() + 600_000 })
    assert.equal(await ensureFreshConnectionToken(conn), conn)
    assert.equal(count(), 1, 'an unreadable stored token must not be presented as valid')
  } finally {
    restore()
  }
})

// ── coalescing ────────────────────────────────────────────────────────────────

test('concurrent refreshes for one connection collapse into a single token request', async () => {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    await new Promise((resolve) => setTimeout(resolve, 20))
    return new Response('nope', { status: 400 })
  }) as typeof fetch
  try {
    const conn = authcodeConn({ expiresAt: 0 })
    const results = await Promise.all([
      ensureFreshConnectionToken(conn),
      ensureFreshConnectionToken(conn),
      ensureFreshConnectionToken(conn),
    ])
    assert.equal(calls, 1, 'two simultaneous runs must not race to double-refresh')
    for (const result of results) assert.equal(result, conn)
  } finally {
    globalThis.fetch = original
  }
})

test('two different connections refresh independently', async () => {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    return new Response('nope', { status: 400 })
  }) as typeof fetch
  try {
    await Promise.all([
      ensureFreshConnectionToken(authcodeConn({ expiresAt: 0 })),
      ensureFreshConnectionToken(authcodeConn({ expiresAt: 0 })),
    ])
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = original
  }
})

test.skip('DB-backed: a successful refresh encrypts and persists the rotated tokens and records a rotation — needs a live database', () => {})
