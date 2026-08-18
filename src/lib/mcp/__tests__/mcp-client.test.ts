import test from 'node:test'
import assert from 'node:assert/strict'

import { McpClient, mcpConfigFromConnection } from '@/lib/mcp/mcp-client'
import { encryptSecret } from '@/lib/crypto/secrets'

// The secrets module reads the key at call time, so setting it here — before
// any test body runs — is enough for a deterministic encrypt/decrypt round trip.
process.env.ENCRYPTION_KEY ||= 'mcp-client-test-key-0123456789abcdef'

/**
 * The client that talks to third-party MCP servers. The transport is stubbed at
 * `fetch`, so these exercise the real handshake, auth-header, parsing and error
 * behavior — including the SSRF guard, which runs before any request.
 */

// An IP literal keeps the SSRF guard from needing DNS while still passing it.
const SERVER = 'https://93.184.216.34/mcp'

type Call = { url: string; method: string; headers: Record<string, string>; body: any }

function stubFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (input: any, init: any) => {
    const url = typeof input === 'string' ? input : String(input)
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) }
    let body: any = init?.body
    if (typeof body === 'string' && body.trim().startsWith('{')) body = JSON.parse(body)
    const call: Call = { url, method: body?.method ?? init?.method ?? 'GET', headers, body }
    calls.push(call)
    return handler(call, calls.length - 1)
  }) as typeof fetch
  return { calls, restore: () => { globalThis.fetch = original } }
}

const json = (payload: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init })

const rpcOk = (result: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  })

/** A server that answers the handshake and delegates everything else. */
function mcpServer(handler: (call: Call) => Response | Promise<Response>) {
  return stubFetch((call) => {
    if (call.body?.method === 'initialize') return rpcOk({}, { 'Mcp-Session-Id': 'sess-1' })
    if (call.body?.method === 'notifications/initialized') return rpcOk(null)
    return handler(call)
  })
}

// ── mcpConfigFromConnection ───────────────────────────────────────────────────

test('an unauthenticated connection produces no credentials', () => {
  const config = mcpConfigFromConnection({ serverUrl: SERVER, authType: 'none', authConfig: { apiKey: 'x' } })
  assert.deepEqual(config, { serverUrl: SERVER, authType: 'none' })
})

test('an api_key connection decrypts the stored key and keeps the header name', () => {
  const config = mcpConfigFromConnection({
    serverUrl: SERVER,
    authType: 'api_key',
    authConfig: { apiKey: encryptSecret('sk-live-123'), headerName: 'X-Api-Key' },
  })
  assert.equal(config.apiKey, 'sk-live-123')
  assert.equal(config.headerName, 'X-Api-Key')
})

test('an oauth2 client-credentials connection decrypts only the client secret', () => {
  const config = mcpConfigFromConnection({
    serverUrl: SERVER,
    authType: 'oauth2',
    authConfig: {
      clientId: 'cid',
      clientSecret: encryptSecret('csecret'),
      tokenUrl: 'https://idp.example.com/token',
      scopes: 'a b',
    },
  })
  assert.equal(config.flow, undefined)
  assert.equal(config.clientId, 'cid')
  assert.equal(config.clientSecret, 'csecret')
  assert.equal(config.tokenUrl, 'https://idp.example.com/token')
  assert.equal(config.scopes, 'a b')
})

test('an authcode connection decrypts both tokens and carries the expiry through', () => {
  const expiresAt = Date.now() + 600_000
  const config = mcpConfigFromConnection({
    serverUrl: SERVER,
    authType: 'oauth2',
    authConfig: {
      flow: 'authcode',
      clientId: 'cid',
      tokenEndpoint: 'https://idp.example.com/token',
      accessToken: encryptSecret('at-1'),
      refreshToken: encryptSecret('rt-1'),
      expiresAt,
    },
  })
  assert.equal(config.flow, 'authcode')
  assert.equal(config.accessToken, 'at-1')
  assert.equal(config.refreshToken, 'rt-1')
  assert.equal(config.expiresAt, expiresAt)
})

test('an unknown authType degrades to unauthenticated and leaks no stored secret', () => {
  const config = mcpConfigFromConnection({
    serverUrl: SERVER,
    authType: 'basic_totally_unknown',
    authConfig: { apiKey: encryptSecret('sk-live-123'), clientSecret: encryptSecret('csecret') },
  })
  assert.equal(config.authType, 'none')
  assert.equal(JSON.stringify(config).includes('sk-live'), false)
  assert.equal(config.apiKey, undefined)
})

test('a non-object authConfig is tolerated rather than crashing the run', () => {
  for (const authConfig of [null, undefined, 'string', ['a'], 42]) {
    const config = mcpConfigFromConnection({ serverUrl: SERVER, authType: 'api_key', authConfig })
    assert.equal(config.authType, 'api_key')
    assert.equal(config.apiKey, undefined)
  }
})

// ── SSRF guard: refused before any request leaves ─────────────────────────────

test('a private or non-https server URL is refused before any request is made', async () => {
  const { calls, restore } = stubFetch(() => rpcOk({}))
  try {
    for (const url of ['https://127.0.0.1/mcp', 'https://169.254.169.254/latest', 'http://93.184.216.34/mcp']) {
      await assert.rejects(() => new McpClient({ serverUrl: url, authType: 'none' }).getServerTools(url), /Ssrf|allowed|private|reserved/i, url)
    }
    assert.equal(calls.length, 0, 'the SSRF guard must run before the transport')
  } finally {
    restore()
  }
})

// ── handshake, session, discovery ─────────────────────────────────────────────

test('initialize runs once per server and the session id rides every later call', async () => {
  const { calls, restore } = mcpServer(() => rpcOk({ tools: [{ name: 'a', inputSchema: { type: 'object' } }] }))
  try {
    const client = new McpClient({ serverUrl: SERVER, authType: 'none' })
    await client.getServerTools(SERVER)
    await client.getServerTools(SERVER)
    await client.executeTool(SERVER, 'a', {})
    assert.equal(calls.filter((c) => c.body?.method === 'initialize').length, 1)
    for (const call of calls.filter((c) => c.body?.method === 'tools/list' || c.body?.method === 'tools/call')) {
      assert.equal(call.headers['Mcp-Session-Id'], 'sess-1')
    }
  } finally {
    restore()
  }
})

test('tools/list normalizes the schema aliases servers actually send', async () => {
  const { restore } = mcpServer(() =>
    rpcOk({
      tools: [
        { name: 'camel', description: 'd', inputSchema: { type: 'object', properties: { a: {} } }, outputSchema: { type: 'string' } },
        { name: 'snake', input_schema: { type: 'object', properties: { b: {} } }, output_schema: { type: 'number' } },
        { name: 'params', parameters: { type: 'object', properties: { c: {} } }, result_schema: { type: 'boolean' } },
        { name: 'bare' },
      ],
    }),
  )
  try {
    const tools = await new McpClient({ serverUrl: SERVER, authType: 'none' }).getServerTools(SERVER)
    assert.deepEqual(tools.map((t) => t.name), ['camel', 'snake', 'params', 'bare'])
    assert.deepEqual(tools[1].inputSchema, { type: 'object', properties: { b: {} } })
    assert.deepEqual(tools[2].inputSchema, { type: 'object', properties: { c: {} } })
    assert.deepEqual(tools[3].inputSchema, { type: 'object', properties: {} }, 'a schema-less tool still gets a callable schema')
    assert.deepEqual(tools[0].outputSchema, { type: 'string' })
    assert.deepEqual(tools[2].outputSchema, { type: 'boolean' })
  } finally {
    restore()
  }
})

test('a server that answers under result.items is read the same way', async () => {
  const { restore } = mcpServer(() => rpcOk({ items: [{ name: 'from_items' }] }))
  try {
    const tools = await new McpClient({ serverUrl: SERVER, authType: 'none' }).getServerTools(SERVER)
    assert.deepEqual(tools.map((t) => t.name), ['from_items'])
  } finally {
    restore()
  }
})

test('a server-sent-events framed reply is parsed like plain JSON', async () => {
  const { restore } = mcpServer(
    () =>
      new Response(
        'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"sse_tool"}]}}\n\ndata: [DONE]\n',
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
  )
  try {
    const tools = await new McpClient({ serverUrl: SERVER, authType: 'none' }).getServerTools(SERVER)
    assert.deepEqual(tools.map((t) => t.name), ['sse_tool'])
  } finally {
    restore()
  }
})

// ── auth headers ──────────────────────────────────────────────────────────────

test('an api key goes out as a bearer by default and as a raw custom header when named', async () => {
  for (const [headerName, expected] of [
    [undefined, { key: 'Authorization', value: 'Bearer sk-1' }],
    ['', { key: 'Authorization', value: 'Bearer sk-1' }],
    ['   ', { key: 'Authorization', value: 'Bearer sk-1' }],
    ['Authorization', { key: 'Authorization', value: 'Bearer sk-1' }],
    ['X-Api-Key', { key: 'X-Api-Key', value: 'sk-1' }],
  ] as const) {
    const { calls, restore } = mcpServer(() => rpcOk({ tools: [] }))
    try {
      await new McpClient({ serverUrl: SERVER, authType: 'api_key', apiKey: 'sk-1', headerName }).getServerTools(SERVER)
      const list = calls.find((c) => c.body?.method === 'tools/list')!
      assert.equal(list.headers[expected.key], expected.value, `headerName=${JSON.stringify(headerName)}`)
    } finally {
      restore()
    }
  }
})

test('an unauthenticated connection sends no authorization header at all', async () => {
  const { calls, restore } = mcpServer(() => rpcOk({ tools: [] }))
  try {
    await new McpClient({ serverUrl: SERVER, authType: 'none', apiKey: 'sk-should-be-ignored' }).getServerTools(SERVER)
    for (const call of calls) {
      assert.equal(call.headers.Authorization, undefined)
      assert.equal(JSON.stringify(call.headers).includes('sk-should-be-ignored'), false)
    }
  } finally {
    restore()
  }
})

test('an api_key connection with no key configured sends no header rather than "Bearer undefined"', async () => {
  const { calls, restore } = mcpServer(() => rpcOk({ tools: [] }))
  try {
    await new McpClient({ serverUrl: SERVER, authType: 'api_key' }).getServerTools(SERVER)
    assert.equal(calls[0].headers.Authorization, undefined)
  } finally {
    restore()
  }
})

// ── errors ────────────────────────────────────────────────────────────────────

test('a non-2xx transport response names the status and the method', async () => {
  const { restore } = stubFetch(() => new Response('nope', { status: 503 }))
  try {
    await assert.rejects(
      () => new McpClient({ serverUrl: SERVER, authType: 'none' }).getServerTools(SERVER),
      /MCP server returned 503 for method initialize/,
    )
  } finally {
    restore()
  }
})

test('a JSON-RPC error on the handshake, listing, or a call is surfaced', async () => {
  const initFail = stubFetch(() => json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'bad handshake' } }))
  try {
    await assert.rejects(() => new McpClient({ serverUrl: SERVER, authType: 'none' }).getServerTools(SERVER), /bad handshake/)
  } finally {
    initFail.restore()
  }

  const listFail = mcpServer(() => json({ jsonrpc: '2.0', id: 2, error: { message: 'listing denied' } }))
  try {
    await assert.rejects(() => new McpClient({ serverUrl: SERVER, authType: 'none' }).getServerTools(SERVER), /listing denied/)
  } finally {
    listFail.restore()
  }

  const callFail = mcpServer(() => json({ jsonrpc: '2.0', id: 2, error: { message: 'tool exploded' } }))
  try {
    await assert.rejects(() => new McpClient({ serverUrl: SERVER, authType: 'none' }).executeTool(SERVER, 'boom', {}), /tool exploded/)
  } finally {
    callFail.restore()
  }
})

test('a message-less JSON-RPC error still names the failing tool', async () => {
  const { restore } = mcpServer(() => json({ jsonrpc: '2.0', id: 2, error: { code: -1 } }))
  try {
    await assert.rejects(
      () => new McpClient({ serverUrl: SERVER, authType: 'none' }).executeTool(SERVER, 'send_email', {}),
      /Tool send_email failed/,
    )
  } finally {
    restore()
  }
})

test('executeTool passes the arguments through and returns the raw result', async () => {
  const { calls, restore } = mcpServer((call) => {
    assert.equal(call.body.params.name, 'find_account')
    return rpcOk({ content: [{ type: 'text', text: 'found' }] })
  })
  try {
    const result = await new McpClient({ serverUrl: SERVER, authType: 'none' }).executeTool(SERVER, 'find_account', { q: 'acme' })
    assert.deepEqual(result, { content: [{ type: 'text', text: 'found' }] })
    const call = calls.find((c) => c.body?.method === 'tools/call')!
    assert.deepEqual(call.body.params, { name: 'find_account', arguments: { q: 'acme' } })
  } finally {
    restore()
  }
})

test('a failed handshake is not remembered as ready', async () => {
  let failNext = true
  const { calls, restore } = stubFetch((call) => {
    if (call.body?.method === 'initialize' && failNext) {
      failNext = false
      return new Response('down', { status: 502 })
    }
    if (call.body?.method === 'initialize') return rpcOk({})
    if (call.body?.method === 'notifications/initialized') return rpcOk(null)
    return rpcOk({ tools: [{ name: 'recovered' }] })
  })
  try {
    const client = new McpClient({ serverUrl: SERVER, authType: 'none' })
    await assert.rejects(() => client.getServerTools(SERVER), /502/)
    const tools = await client.getServerTools(SERVER)
    assert.deepEqual(tools.map((t) => t.name), ['recovered'])
    assert.equal(calls.filter((c) => c.body?.method === 'initialize').length, 2)
  } finally {
    restore()
  }
})
