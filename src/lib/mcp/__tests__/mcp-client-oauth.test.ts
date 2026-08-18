import test from 'node:test'
import assert from 'node:assert/strict'
import { McpClient } from '@/lib/mcp/mcp-client'

/**
 * The two OAuth paths of the MCP client: client-credentials (with endpoint
 * auto-discovery) and the authorization-code flow's refresh + persist hook.
 * Split from mcp-client.test.ts to keep each file well under the loader's size
 * cliff.
 */

const SERVER = 'https://93.184.216.34/mcp'
const TOKEN_URL = 'https://93.184.216.35/token'
const DISCOVERY = 'https://93.184.216.34/.well-known/oauth-authorization-server'

type Call = { url: string; rpcMethod?: string; headers: Record<string, string>; body: any; rawBody?: string }

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : String(input)
    const rawBody = typeof init?.body === 'string' ? init.body : undefined
    let body: any = rawBody
    if (rawBody?.trim().startsWith('{')) body = JSON.parse(rawBody)
    const call: Call = {
      url,
      rpcMethod: typeof body === 'object' ? body?.method : undefined,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body,
      rawBody,
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

const rpcOk = (result: unknown) => json({ jsonrpc: '2.0', id: 1, result })

/** Handshake + tools/list; everything else goes to `handler`. */
function mcpAnd(handler: (call: Call) => Response | Promise<Response> | undefined) {
  return stubFetch((call) => {
    const custom = handler(call)
    if (custom) return custom
    if (call.rpcMethod === 'initialize') return rpcOk({})
    if (call.rpcMethod === 'notifications/initialized') return rpcOk(null)
    if (call.rpcMethod === 'tools/list') return rpcOk({ tools: [{ name: 'ok' }] })
    if (call.rpcMethod === 'tools/call') return rpcOk({ content: [] })
    return json({ jsonrpc: '2.0', id: 1, error: { message: `unexpected ${call.url}` } })
  })
}

const ccClient = (overrides: Record<string, unknown> = {}) =>
  new McpClient({
    serverUrl: SERVER,
    authType: 'oauth2',
    clientId: 'cid',
    clientSecret: 'csecret',
    tokenUrl: TOKEN_URL,
    ...overrides,
  } as never)

// ── client credentials ────────────────────────────────────────────────────────

test('a client-credentials connection fetches a token once and reuses it', async () => {
  const { calls, restore } = mcpAnd((call) =>
    call.url === TOKEN_URL ? json({ access_token: 'tok-1', expires_in: 3600 }) : undefined,
  )
  try {
    const client = ccClient()
    await client.getServerTools(SERVER)
    await client.getServerTools(SERVER)
    assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1, 'a cached token must not be re-fetched')
    const token = calls.find((c) => c.url === TOKEN_URL)!
    assert.match(token.rawBody!, /grant_type=client_credentials/)
    assert.match(token.headers.Authorization, /^Basic /)
    for (const rpc of calls.filter((c) => c.rpcMethod)) {
      assert.equal(rpc.headers.Authorization, 'Bearer tok-1')
    }
  } finally {
    restore()
  }
})

test('concurrent calls coalesce into a single token request', async () => {
  const { calls, restore } = mcpAnd((call) =>
    call.url === TOKEN_URL ? json({ access_token: 'tok-1', expires_in: 3600 }) : undefined,
  )
  try {
    const client = ccClient()
    await Promise.all([client.getServerTools(SERVER), client.getServerTools(SERVER), client.getServerTools(SERVER)])
    assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1)
  } finally {
    restore()
  }
})

test('the configured scope rides the token request', async () => {
  const { calls, restore } = mcpAnd((call) =>
    call.url === TOKEN_URL ? json({ access_token: 'tok-1' }) : undefined,
  )
  try {
    await ccClient({ scopes: 'read:accounts write:notes' }).getServerTools(SERVER)
    assert.match(calls.find((c) => c.url === TOKEN_URL)!.rawBody!, /scope=read%3Aaccounts\+write%3Anotes/)
  } finally {
    restore()
  }
})

test('with no token URL configured the endpoint is auto-discovered from the server origin', async () => {
  const { calls, restore } = mcpAnd((call) => {
    if (call.url === DISCOVERY) return json({ token_endpoint: TOKEN_URL })
    if (call.url === TOKEN_URL) return json({ access_token: 'tok-discovered' })
    return undefined
  })
  try {
    await ccClient({ tokenUrl: undefined }).getServerTools(SERVER)
    assert.ok(calls.some((c) => c.url === DISCOVERY), 'discovery must be attempted')
    const rpc = calls.find((c) => c.rpcMethod === 'tools/list')!
    assert.equal(rpc.headers.Authorization, 'Bearer tok-discovered')
  } finally {
    restore()
  }
})

test('a failed or incomplete discovery is a clear error, not a silent unauthenticated call', async () => {
  const notFound = mcpAnd((call) => (call.url === DISCOVERY ? new Response('no', { status: 404 }) : undefined))
  try {
    await assert.rejects(() => ccClient({ tokenUrl: undefined }).getServerTools(SERVER), /auto-discovery failed \(status 404\)/)
  } finally {
    notFound.restore()
  }

  const noEndpoint = mcpAnd((call) => (call.url === DISCOVERY ? json({ issuer: 'x' }) : undefined))
  try {
    await assert.rejects(() => ccClient({ tokenUrl: undefined }).getServerTools(SERVER), /did not include token_endpoint/)
  } finally {
    noEndpoint.restore()
  }
})

test('a token request failure reports the status and never echoes the response body', async () => {
  const { restore } = mcpAnd((call) =>
    call.url === TOKEN_URL ? new Response('{"error":"invalid_client","hint":"secret sk-leak"}', { status: 401 }) : undefined,
  )
  try {
    await assert.rejects(() => ccClient().getServerTools(SERVER), (error: Error) => {
      assert.match(error.message, /token request failed with status 401/)
      assert.equal(error.message.includes('sk-leak'), false, 'the upstream body must not be echoed')
      return true
    })
  } finally {
    restore()
  }
})

test('a token response with no access_token is rejected', async () => {
  const { restore } = mcpAnd((call) => (call.url === TOKEN_URL ? json({ token_type: 'bearer' }) : undefined))
  try {
    await assert.rejects(() => ccClient().getServerTools(SERVER), /did not include access_token/)
  } finally {
    restore()
  }
})

test('oauth2 without credentials fails loudly instead of calling out unauthenticated', async () => {
  const { calls, restore } = mcpAnd(() => undefined)
  try {
    await assert.rejects(
      () => new McpClient({ serverUrl: SERVER, authType: 'oauth2', tokenUrl: TOKEN_URL }).getServerTools(SERVER),
      /clientId and clientSecret are required/,
    )
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

// ── authorization-code flow ───────────────────────────────────────────────────

const authcodeClient = (overrides: Record<string, unknown> = {}) =>
  new McpClient({
    serverUrl: SERVER,
    authType: 'oauth2',
    flow: 'authcode',
    clientId: 'cid',
    clientSecret: 'csecret',
    tokenEndpoint: TOKEN_URL,
    accessToken: 'at-stored',
    refreshToken: 'rt-stored',
    expiresAt: Date.now() + 600_000,
    ...overrides,
  } as never)

test('a still-valid stored access token is used without contacting the token endpoint', async () => {
  const { calls, restore } = mcpAnd(() => undefined)
  try {
    await authcodeClient().getServerTools(SERVER)
    assert.equal(calls.some((c) => c.url === TOKEN_URL), false, 'a valid token must not trigger a refresh')
    assert.equal(calls.find((c) => c.rpcMethod === 'tools/list')!.headers.Authorization, 'Bearer at-stored')
  } finally {
    restore()
  }
})

test('a token inside the 60-second safety margin is refreshed rather than used', async () => {
  const { calls, restore } = mcpAnd((call) =>
    call.url === TOKEN_URL ? json({ access_token: 'at-fresh', refresh_token: 'rt-rotated', expires_in: 3600 }) : undefined,
  )
  try {
    await authcodeClient({ expiresAt: Date.now() + 30_000 }).getServerTools(SERVER)
    const refresh = calls.find((c) => c.url === TOKEN_URL)!
    assert.match(refresh.rawBody!, /grant_type=refresh_token/)
    assert.match(refresh.rawBody!, /refresh_token=rt-stored/)
    assert.equal(calls.find((c) => c.rpcMethod === 'tools/list')!.headers.Authorization, 'Bearer at-fresh')
  } finally {
    restore()
  }
})

test('a rotated refresh token is handed to the persistence hook so the next run keeps working', async () => {
  const persisted: any[] = []
  const { restore } = mcpAnd((call) =>
    call.url === TOKEN_URL ? json({ access_token: 'at-fresh', refresh_token: 'rt-rotated', expires_in: 900 }) : undefined,
  )
  try {
    await authcodeClient({
      expiresAt: 0,
      persistTokens: async (tokens: unknown) => { persisted.push(tokens) },
    }).getServerTools(SERVER)
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].access_token, 'at-fresh')
    assert.equal(persisted[0].refresh_token, 'rt-rotated')
  } finally {
    restore()
  }
})

test('a persistence failure never breaks the run', async () => {
  const { restore } = mcpAnd((call) =>
    call.url === TOKEN_URL ? json({ access_token: 'at-fresh', expires_in: 900 }) : undefined,
  )
  try {
    const tools = await authcodeClient({
      expiresAt: 0,
      persistTokens: async () => { throw new Error('database down') },
    }).getServerTools(SERVER)
    assert.deepEqual(tools.map((t) => t.name), ['ok'])
  } finally {
    restore()
  }
})

test('a token refreshed once is reused for the rest of the run', async () => {
  const { calls, restore } = mcpAnd((call) =>
    call.url === TOKEN_URL ? json({ access_token: 'at-fresh', expires_in: 3600 }) : undefined,
  )
  try {
    const client = authcodeClient({ expiresAt: 0 })
    await client.getServerTools(SERVER)
    await client.executeTool(SERVER, 'ok', {})
    assert.equal(calls.filter((c) => c.url === TOKEN_URL).length, 1)
  } finally {
    restore()
  }
})

test('an expired authcode connection with nothing to refresh with fails with an actionable message', async () => {
  const { restore } = mcpAnd(() => undefined)
  try {
    for (const missing of [{ refreshToken: undefined }, { clientId: undefined }, { tokenEndpoint: undefined }]) {
      await assert.rejects(
        () => authcodeClient({ expiresAt: 0, ...missing }).getServerTools(SERVER),
        /missing refreshToken\/clientId\/tokenEndpoint/,
        JSON.stringify(missing),
      )
    }
  } finally {
    restore()
  }
})

test('a refresh that the identity provider rejects surfaces the status', async () => {
  const { restore } = mcpAnd((call) => (call.url === TOKEN_URL ? new Response('bad', { status: 400 }) : undefined))
  try {
    await assert.rejects(() => authcodeClient({ expiresAt: 0 }).getServerTools(SERVER), /Token refresh failed \(status 400\)/)
  } finally {
    restore()
  }
})
