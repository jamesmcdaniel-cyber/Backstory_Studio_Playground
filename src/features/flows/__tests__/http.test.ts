import { test } from 'node:test'
import assert from 'node:assert/strict'
import { prepareHttpRequest, responseOutput, withBearerAuthorization, redactAuthHeaders, redactHttpStepInput } from '../http'

test('prepareHttpRequest appends query params and sends JSON bodies', () => {
  const request = prepareHttpRequest({
    method: 'POST',
    url: 'https://api.example.com/accounts',
    query: { tag: ['a', 'b'], active: true },
    headers: { authorization: 'Bearer token' },
    body: { account: 'Acme' },
    bodyMode: 'json',
  })
  assert.equal(request.url, 'https://api.example.com/accounts?tag=a&tag=b&active=true')
  assert.equal(request.init.method, 'POST')
  assert.deepEqual(request.init.headers, { authorization: 'Bearer token', 'content-type': 'application/json' })
  assert.equal(request.init.body, '{"account":"Acme"}')
})

test('prepareHttpRequest sends a Cookie header from the cookie field', () => {
  const request = prepareHttpRequest({
    method: 'GET',
    url: 'https://api.example.com/me',
    cookie: 'session=abc; theme=dark',
  })
  assert.equal((request.init.headers as Record<string, string>).cookie, 'session=abc; theme=dark')
})

test('an explicit Cookie header wins over the cookie field', () => {
  const request = prepareHttpRequest({
    method: 'GET',
    url: 'https://api.example.com/me',
    headers: { Cookie: 'from=header' },
    cookie: 'from=field',
  })
  const headers = request.init.headers as Record<string, string>
  const cookieVals = Object.entries(headers).filter(([k]) => k.toLowerCase() === 'cookie').map(([, v]) => v)
  assert.deepEqual(cookieVals, ['from=header'])
})

test('prepareHttpRequest omits body for GET and supports text body mode', () => {
  const get = prepareHttpRequest({ method: 'GET', url: 'https://api.example.com/search', body: '{"ignored":true}', bodyMode: 'json' })
  assert.equal(get.init.body, undefined)

  const post = prepareHttpRequest({ method: 'POST', url: 'https://api.example.com/hook', body: 'hello', bodyMode: 'text' })
  assert.equal(post.init.body, 'hello')
  assert.deepEqual(post.init.headers, {})
})

test('prepareHttpRequest validates object-shaped headers and query params', () => {
  assert.throws(() => prepareHttpRequest({ url: 'https://api.example.com', headers: '[]' }), /Headers/)
  assert.throws(() => prepareHttpRequest({ url: 'https://api.example.com', query: '"bad"' }), /Query/)
})

test('prepareHttpRequest preserves existing query params and clamps request options', () => {
  const request = prepareHttpRequest({
    method: 'PATCH',
    url: 'https://api.example.com/search?existing=1',
    query: '{"tag":["a","b"],"active":true}',
    headers: '{"x-count": 5}',
    timeoutMs: 999999,
    failOnHttpError: false,
    responseType: 'text',
    body: '{"ok":true}',
  })
  assert.equal(request.url, 'https://api.example.com/search?existing=1&tag=a&tag=b&active=true')
  assert.deepEqual(request.init.headers, { 'x-count': '5', 'content-type': 'application/json' })
  assert.equal(request.timeoutMs, 120000)
  assert.equal(request.failOnHttpError, false)
  assert.equal(request.responseType, 'text')
})

test('prepareHttpRequest rejects invalid JSON bodies when JSON mode is explicit', () => {
  assert.throws(
    () => prepareHttpRequest({ method: 'POST', url: 'https://api.example.com', bodyMode: 'json', body: '{broken' }),
    /not valid JSON/,
  )
})

test('prepareHttpRequest supports raw, GraphQL, and URL-encoded body modes', () => {
  const raw = prepareHttpRequest({
    method: 'POST',
    url: 'https://api.example.com/raw',
    sendBody: true,
    bodyMode: 'raw',
    contentType: 'text/html',
    body: '<p>Hello</p>',
  })
  assert.equal(raw.init.body, '<p>Hello</p>')
  assert.equal((raw.init.headers as Record<string, string>)['content-type'], 'text/html')

  const graphql = prepareHttpRequest({
    method: 'POST',
    url: 'https://api.example.com/graphql',
    sendBody: true,
    bodyMode: 'graphql',
    body: 'query Viewer { viewer { id } }',
  })
  assert.deepEqual(JSON.parse(String(graphql.init.body)), { query: 'query Viewer { viewer { id } }' })
  assert.equal((graphql.init.headers as Record<string, string>)['content-type'], 'application/json')

  const form = prepareHttpRequest({
    method: 'POST',
    url: 'https://api.example.com/token',
    sendBody: true,
    bodyMode: 'form-urlencoded',
    body: '{"grant_type":"client_credentials","scope":"read write"}',
  })
  assert.equal(form.init.body, 'grant_type=client_credentials&scope=read+write')
  assert.equal((form.init.headers as Record<string, string>)['content-type'], 'application/x-www-form-urlencoded')
})

test('HTTP send toggles preserve configuration while excluding disabled sections', () => {
  const request = prepareHttpRequest({
    method: 'POST',
    url: 'https://api.example.com/items',
    sendQuery: false,
    query: '{"page":2}',
    sendHeaders: false,
    headers: '{"x-debug":"true"}',
    sendBody: false,
    bodyMode: 'json',
    body: '{"ignored":true}',
  })
  assert.equal(request.url, 'https://api.example.com/items')
  assert.deepEqual(request.init.headers, {})
  assert.equal(request.init.body, undefined)
})

test('withBearerAuthorization injects a bearer token when no auth header is set', () => {
  const headers = { 'content-type': 'application/json' }
  const next = withBearerAuthorization(headers, 'tok-123')
  assert.deepEqual(next, { 'content-type': 'application/json', authorization: 'Bearer tok-123' })
  // Input is not mutated
  assert.deepEqual(headers, { 'content-type': 'application/json' })
})

test('withBearerAuthorization never overrides an explicit Authorization header', () => {
  assert.deepEqual(
    withBearerAuthorization({ authorization: 'Bearer mine' }, 'tok-123'),
    { authorization: 'Bearer mine' },
  )
  // Case-insensitive: any casing of the user's header wins
  assert.deepEqual(
    withBearerAuthorization({ Authorization: 'Basic abc' }, 'tok-123'),
    { Authorization: 'Basic abc' },
  )
  assert.deepEqual(
    withBearerAuthorization({ 'Proxy-Authorization': 'Basic abc' }, 'tok-123'),
    { 'Proxy-Authorization': 'Basic abc' },
  )
  // Header names with surrounding whitespace still count as explicit
  assert.deepEqual(
    withBearerAuthorization({ ' authorization': 'Bearer mine' }, 'tok-123'),
    { ' authorization': 'Bearer mine' },
  )
})

test('withBearerAuthorization treats empty Authorization values as absent', () => {
  // A template that resolved to an empty string must not block injection or
  // leave a blank credential on the request
  assert.deepEqual(
    withBearerAuthorization({ Authorization: '', 'x-id': 'a' }, 'tok-123'),
    { 'x-id': 'a', authorization: 'Bearer tok-123' },
  )
  assert.deepEqual(
    withBearerAuthorization({ authorization: '   ' }, 'tok-123'),
    { authorization: 'Bearer tok-123' },
  )
})

test('redactAuthHeaders replaces auth header values in objects, any casing', () => {
  assert.deepEqual(
    redactAuthHeaders({ Authorization: 'Bearer secret', 'x-count': 5 }),
    { Authorization: 'redacted', 'x-count': 5 },
  )
  assert.deepEqual(
    redactAuthHeaders({ authorization: 'Basic secret', 'proxy-authorization': 'secret' }),
    { authorization: 'redacted', 'proxy-authorization': 'redacted' },
  )
  // Key trimming is symmetric with injection precedence; empty values still redact
  assert.deepEqual(
    redactAuthHeaders({ ' Authorization ': 'Bearer secret', authorization: '' }),
    { ' Authorization ': 'redacted', authorization: 'redacted' },
  )
})

test('redactAuthHeaders handles JSON strings and non-JSON strings', () => {
  assert.equal(
    redactAuthHeaders('{"authorization":"Bearer secret","x-id":"1"}'),
    '{"authorization":"redacted","x-id":"1"}',
  )
  // Non-JSON string that mentions an auth header: drop it entirely
  assert.equal(redactAuthHeaders('Authorization: Bearer secret'), 'redacted')
  // Harmless strings and non-header values pass through
  assert.equal(redactAuthHeaders('x-count: 5'), 'x-count: 5')
  assert.equal(redactAuthHeaders(undefined), undefined)
})

test('redactHttpStepInput redacts only the headers field and keeps the rest', () => {
  const config = {
    method: 'POST',
    url: 'https://api.example.com',
    headers: { authorization: 'Bearer secret', 'x-id': 'a' },
    body: '{"ok":true}',
    connectionId: 'conn-1',
  }
  const safe = redactHttpStepInput(config)
  assert.deepEqual(safe.headers, { authorization: 'redacted', 'x-id': 'a' })
  assert.equal(safe.url, 'https://api.example.com')
  assert.equal(safe.body, '{"ok":true}')
  assert.equal(safe.connectionId, 'conn-1')
  // Original config untouched
  assert.deepEqual(config.headers, { authorization: 'Bearer secret', 'x-id': 'a' })
  // No headers set: config passes through unchanged
  const bare = { method: 'GET', url: 'https://api.example.com' }
  assert.deepEqual(redactHttpStepInput(bare), bare)
})

test('responseOutput auto-parses JSON responses and keeps raw body text', async () => {
  const response = new Response('{"ok":true}', {
    status: 201,
    statusText: 'Created',
    headers: { 'content-type': 'application/json' },
  })
  const output = await responseOutput(response, 'auto')
  assert.equal(output.ok, true)
  assert.equal(output.status, 201)
  assert.deepEqual(output.body, { ok: true })
  assert.equal(output.bodyText, '{"ok":true}')
})

test('responseOutput can force text or JSON parsing', async () => {
  const text = await responseOutput(new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }), 'text')
  assert.equal(text.body, '{"ok":true}')
  await assert.rejects(() => responseOutput(new Response('not-json'), 'json'), /not valid JSON/)
})

test('a JSON response larger than the display cap stays STRUCTURED (parsed before truncation)', async () => {
  // A big list of records — its JSON text far exceeds the display cap. The old
  // behavior truncated first, corrupting the JSON so `.body` became a truncated
  // string and downstream field reads silently blanked. Now `.body` is the full
  // parsed array; only `.bodyText` is capped.
  const records = Array.from({ length: 400 }, (_, i) => ({ id: i, name: `Account ${i}`, note: 'x'.repeat(40) }))
  const json = JSON.stringify(records)
  assert.ok(json.length > 500, 'fixture should exceed the tiny cap used here')
  const output = await responseOutput(new Response(json, { headers: { 'content-type': 'application/json' } }), 'auto', 500)
  assert.ok(Array.isArray(output.body), 'body must remain a parsed array, not a truncated string')
  assert.equal((output.body as unknown[]).length, 400, 'all records survive — no silent data loss')
  assert.equal((output.body as { name: string }[])[399].name, 'Account 399')
  assert.equal(output.bodyText.length, 500, 'the raw-text mirror is still capped for display/persistence')
})
