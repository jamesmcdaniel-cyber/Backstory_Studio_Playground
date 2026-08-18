import test from 'node:test'
import assert from 'node:assert/strict'
import { BackstoryMcpClient, backstoryMcpConfigured } from '@/lib/mcp/backstory-mcp'

/**
 * The People.ai / Backstory MCP transport. Its token cache lives at MODULE
 * scope (one per process), so the tests below are ordered deliberately: every
 * failure path runs before the one test that populates the cache, and the
 * remaining tests authenticate with a static token, which short-circuits the
 * cache entirely.
 */

const SERVER = 'https://backstory.example.com/mcp'

const ENV_KEYS = [
  'BACKSTORY_MCP_URL',
  'BACKSTORY_MCP_TOKEN',
  'BACKSTORY_MCP_TOKEN_URL',
  'BACKSTORY_MCP_CLIENT_ID',
  'BACKSTORY_MCP_CLIENT_SECRET',
  'BACKSTORY_MCP_SCOPES',
  'PEOPLE_AI_MCP_TIMEOUT_MS',
] as const

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  return () => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

type Call = { url: string; rpcMethod?: string; headers: Record<string, string>; body: any; rawBody?: string }

function stubFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any) => {
    const rawBody = typeof init?.body === 'string' ? init.body : undefined
    let body: any = rawBody
    if (rawBody?.trim().startsWith('{')) body = JSON.parse(rawBody)
    const call: Call = {
      url: typeof input === 'string' ? input : String(input),
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

const json = (payload: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const rpcOk = (result: unknown, headers: Record<string, string> = {}) =>
  json({ jsonrpc: '2.0', id: 1, result }, 200, headers)

/** Handshake + a default tools/list; `handler` may take anything first. */
function backstoryServer(handler: (call: Call) => Response | Promise<Response> | undefined = () => undefined) {
  return stubFetch((call) => {
    const custom = handler(call)
    if (custom) return custom
    if (call.rpcMethod === 'initialize') return rpcOk({}, { 'Mcp-Session-Id': 'pai-session' })
    if (call.rpcMethod === 'notifications/initialized') return rpcOk(null)
    if (call.rpcMethod === 'tools/list') return rpcOk({ tools: [{ name: 'find_account', description: 'd' }] })
    if (call.rpcMethod === 'tools/call') return rpcOk({ content: [{ type: 'text', text: 'ok' }] })
    return json({ jsonrpc: '2.0', id: 1, error: { message: `unexpected ${call.url}` } })
  })
}

// ── configuration gate ────────────────────────────────────────────────────────

test('the plane counts as configured only with a URL plus one complete credential', () => {
  const cases: [Partial<Record<(typeof ENV_KEYS)[number], string>>, boolean][] = [
    [{}, false],
    [{ BACKSTORY_MCP_URL: SERVER }, false],
    [{ BACKSTORY_MCP_TOKEN: 't' }, false],
    [{ BACKSTORY_MCP_URL: SERVER, BACKSTORY_MCP_TOKEN: 't' }, true],
    [{ BACKSTORY_MCP_URL: SERVER, BACKSTORY_MCP_TOKEN_URL: 'https://idp/t', BACKSTORY_MCP_CLIENT_ID: 'c' }, false],
    [
      {
        BACKSTORY_MCP_URL: SERVER,
        BACKSTORY_MCP_TOKEN_URL: 'https://idp/t',
        BACKSTORY_MCP_CLIENT_ID: 'c',
        BACKSTORY_MCP_CLIENT_SECRET: 's',
      },
      true,
    ],
  ]
  for (const [env, expected] of cases) {
    const restore = withEnv(env)
    try {
      assert.equal(backstoryMcpConfigured(), expected, JSON.stringify(env))
    } finally {
      restore()
    }
  }
})

// ── credential failures (run before anything populates the module cache) ──────

test('with no credentials at all the client refuses instead of calling out anonymously', async () => {
  const restoreEnv = withEnv({ BACKSTORY_MCP_URL: SERVER })
  const { calls, restore } = backstoryServer()
  try {
    await assert.rejects(() => new BackstoryMcpClient().getServerTools(SERVER), /no auth configured/i)
    assert.equal(calls.length, 0, 'no request may leave without a credential')
  } finally {
    restore()
    restoreEnv()
  }
})

test('a rejected token request reports the status without echoing the body', async () => {
  const restoreEnv = withEnv({
    BACKSTORY_MCP_URL: SERVER,
    BACKSTORY_MCP_TOKEN_URL: 'https://idp.example.com/token',
    BACKSTORY_MCP_CLIENT_ID: 'cid',
    BACKSTORY_MCP_CLIENT_SECRET: 'csecret',
  })
  const { restore } = backstoryServer((call) =>
    call.url.includes('/token') ? new Response('{"error":"invalid_client","detail":"sk-leak"}', { status: 401 }) : undefined,
  )
  try {
    await assert.rejects(() => new BackstoryMcpClient().getServerTools(SERVER), (error: Error) => {
      assert.match(error.message, /token request failed with status 401/)
      assert.equal(error.message.includes('sk-leak'), false)
      return true
    })
  } finally {
    restore()
    restoreEnv()
  }
})

test('a token response without an access token is rejected', async () => {
  const restoreEnv = withEnv({
    BACKSTORY_MCP_URL: SERVER,
    BACKSTORY_MCP_TOKEN_URL: 'https://idp.example.com/token',
    BACKSTORY_MCP_CLIENT_ID: 'cid',
    BACKSTORY_MCP_CLIENT_SECRET: 'csecret',
  })
  const { restore } = backstoryServer((call) =>
    call.url.includes('/token') ? json({ token_type: 'bearer' }) : undefined,
  )
  try {
    await assert.rejects(() => new BackstoryMcpClient().getServerTools(SERVER), /did not include access_token/)
  } finally {
    restore()
    restoreEnv()
  }
})

test('a client-credentials token is fetched once and shared across clients in the process', async () => {
  const restoreEnv = withEnv({
    BACKSTORY_MCP_URL: SERVER,
    BACKSTORY_MCP_TOKEN_URL: 'https://idp.example.com/token',
    BACKSTORY_MCP_CLIENT_ID: 'cid',
    BACKSTORY_MCP_CLIENT_SECRET: 'csecret',
    BACKSTORY_MCP_SCOPES: 'read:all',
  })
  const { calls, restore } = backstoryServer((call) =>
    call.url.includes('/token') ? json({ access_token: 'pai-tok', expires_in: 3600 }) : undefined,
  )
  try {
    await new BackstoryMcpClient().getServerTools(SERVER)
    await new BackstoryMcpClient().getServerTools(SERVER)
    const tokenCalls = calls.filter((c) => c.url.includes('/token'))
    assert.equal(tokenCalls.length, 1, 'the module-level token cache must serve the second client')
    assert.match(tokenCalls[0].rawBody!, /grant_type=client_credentials/)
    assert.match(tokenCalls[0].rawBody!, /scope=read%3Aall/)
    assert.match(tokenCalls[0].headers.Authorization, /^Basic /)
    for (const rpc of calls.filter((c) => c.rpcMethod)) {
      assert.equal(rpc.headers.Authorization, 'Bearer pai-tok')
    }
  } finally {
    restore()
    restoreEnv()
  }
})

// ── transport behavior (static token short-circuits the cache) ────────────────

const staticEnv = { BACKSTORY_MCP_URL: SERVER, BACKSTORY_MCP_TOKEN: 'static-token' }

test('a static token is preferred over any cached client-credentials token', async () => {
  const restoreEnv = withEnv(staticEnv)
  const { calls, restore } = backstoryServer()
  try {
    await new BackstoryMcpClient().getServerTools(SERVER)
    assert.equal(calls.some((c) => c.url.includes('/token')), false)
    for (const call of calls) assert.equal(call.headers.Authorization, 'Bearer static-token')
  } finally {
    restore()
    restoreEnv()
  }
})

test('initialize runs once and its session id rides every later request', async () => {
  const restoreEnv = withEnv(staticEnv)
  const { calls, restore } = backstoryServer()
  try {
    const client = new BackstoryMcpClient()
    await client.getServerTools(SERVER)
    await client.executeTool(SERVER, 'find_account', { q: 'acme' })
    assert.equal(calls.filter((c) => c.rpcMethod === 'initialize').length, 1)
    for (const call of calls.filter((c) => c.rpcMethod === 'tools/list' || c.rpcMethod === 'tools/call')) {
      assert.equal(call.headers['Mcp-Session-Id'], 'pai-session')
    }
    // The initialized notification carries no id — it is a notification.
    const note = calls.find((c) => c.rpcMethod === 'notifications/initialized')!
    assert.equal('id' in note.body, false)
  } finally {
    restore()
    restoreEnv()
  }
})

test('tool schemas are normalized and a schema-less tool still gets one', async () => {
  const restoreEnv = withEnv(staticEnv)
  const { restore } = backstoryServer((call) =>
    call.rpcMethod === 'tools/list'
      ? rpcOk({
          tools: [
            { name: 'a', inputSchema: { type: 'object', properties: { x: {} } } },
            { name: 'b', input_schema: { type: 'object', properties: { y: {} } } },
            { name: 'c', parameters: { type: 'object', properties: { z: {} } } },
            { name: 'd' },
          ],
        })
      : undefined,
  )
  try {
    const tools = await new BackstoryMcpClient().getServerTools(SERVER)
    assert.deepEqual(tools.map((t) => t.name), ['a', 'b', 'c', 'd'])
    assert.deepEqual(tools[1].inputSchema, { type: 'object', properties: { y: {} } })
    assert.deepEqual(tools[2].inputSchema, { type: 'object', properties: { z: {} } })
    assert.deepEqual(tools[3].inputSchema, { type: 'object', properties: {} })
  } finally {
    restore()
    restoreEnv()
  }
})

test('an events-framed reply is parsed like plain JSON', async () => {
  const restoreEnv = withEnv(staticEnv)
  const { restore } = backstoryServer((call) =>
    call.rpcMethod === 'tools/call'
      ? new Response('data: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"streamed"}]}}\n\ndata: [DONE]\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      : undefined,
  )
  try {
    const result = await new BackstoryMcpClient().executeTool(SERVER, 'find_account', {})
    assert.deepEqual(result, { content: [{ type: 'text', text: 'streamed' }] })
  } finally {
    restore()
    restoreEnv()
  }
})

test('a transport failure and a JSON-RPC error are both surfaced', async () => {
  const restoreEnv = withEnv(staticEnv)
  const down = backstoryServer(() => new Response('gateway', { status: 502 }))
  try {
    await assert.rejects(() => new BackstoryMcpClient().getServerTools(SERVER), /returned 502 for method initialize/)
  } finally {
    down.restore()
  }

  const denied = backstoryServer((call) =>
    call.rpcMethod === 'tools/call' ? json({ jsonrpc: '2.0', id: 2, error: { message: 'not entitled' } }) : undefined,
  )
  try {
    await assert.rejects(() => new BackstoryMcpClient().executeTool(SERVER, 'find_account', {}), /not entitled/)
  } finally {
    denied.restore()
  }

  const bare = backstoryServer((call) =>
    call.rpcMethod === 'tools/call' ? json({ jsonrpc: '2.0', id: 2, error: { code: -1 } }) : undefined,
  )
  try {
    await assert.rejects(() => new BackstoryMcpClient().executeTool(SERVER, 'get_scorecard', {}), /Tool get_scorecard failed/)
  } finally {
    bare.restore()
    restoreEnv()
  }
})

test('a nonsense timeout setting cannot break the request', async () => {
  for (const value of ['not-a-number', '-1', '0', '']) {
    const restoreEnv = withEnv({ ...staticEnv, PEOPLE_AI_MCP_TIMEOUT_MS: value })
    const { restore } = backstoryServer()
    try {
      const tools = await new BackstoryMcpClient().getServerTools(SERVER)
      assert.deepEqual(tools.map((t) => t.name), ['find_account'], `timeout="${value}"`)
    } finally {
      restore()
      restoreEnv()
    }
  }
})
