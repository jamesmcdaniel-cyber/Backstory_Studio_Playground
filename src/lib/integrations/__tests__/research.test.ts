import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BRAVE_SEARCH_ENDPOINT,
  ResearchToolClient,
  htmlToText,
  normalizeBraveResults,
  researchTools,
} from '@/lib/integrations/research'

/** A guarded-fetch stand-in that records the request and replays a canned reply. */
function stubFetch(reply: { status?: number; body: string; headers?: Record<string, string> }) {
  const calls: Array<{ url: string; init: RequestInit; options: unknown }> = []
  const guarded = (async (url: string, init: RequestInit = {}, options?: unknown) => {
    calls.push({ url, init, options })
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    })
  }) as unknown as ConstructorParameters<typeof ResearchToolClient>[1]
  return { guarded, calls }
}

const BRAVE_PAYLOAD = JSON.stringify({
  web: {
    results: [
      {
        title: 'Acme raises Series C',
        url: 'https://news.example.com/acme-series-c',
        description: 'Acme closed a <strong>$40M</strong> round led by Example Ventures.',
        age: '2 days ago',
        profile: { name: 'Example News' },
      },
      { title: 'Acme hires CRO', url: 'https://news.example.com/acme-cro', description: 'Leadership change.' },
    ],
  },
})

test('search normalizes results and drops the engine’s match markup', () => {
  const [first, second] = normalizeBraveResults(JSON.parse(BRAVE_PAYLOAD), 10)
  assert.equal(first.title, 'Acme raises Series C')
  assert.equal(first.url, 'https://news.example.com/acme-series-c')
  // <strong> around matched terms would otherwise be reproduced in prose the
  // model writes from the snippet.
  assert.equal(first.snippet, 'Acme closed a $40M round led by Example Ventures.')
  assert.equal(first.age, '2 days ago')
  assert.equal(first.siteName, 'Example News')
  // Absent optional fields are omitted, not emitted as empty strings.
  assert.ok(!('age' in second))
  assert.ok(!('siteName' in second))
})

test('search normalization survives a payload that is not the shape we expect', () => {
  assert.deepEqual(normalizeBraveResults(null, 5), [])
  assert.deepEqual(normalizeBraveResults({}, 5), [])
  assert.deepEqual(normalizeBraveResults({ web: { results: 'nope' } }, 5), [])
  assert.equal(normalizeBraveResults({ web: { results: [{}, {}, {}] } }, 2).length, 2)
})

test('search sends the key as a header, caps count, and refuses redirects', async () => {
  const { guarded, calls } = stubFetch({ body: BRAVE_PAYLOAD })
  const client = new ResearchToolClient('key-123', guarded)
  const result = (await client.executeTool('', 'web_search', {
    query: 'acme funding',
    count: 500,
    freshness: 'past_week',
  })) as { query: string; results: unknown[] }

  const call = calls[0]
  const url = new URL(call.url)
  assert.equal(`${url.origin}${url.pathname}`, BRAVE_SEARCH_ENDPOINT)
  assert.equal(url.searchParams.get('q'), 'acme funding')
  assert.equal(url.searchParams.get('count'), '20', 'an absurd count is clamped, not forwarded')
  assert.equal(url.searchParams.get('freshness'), 'pw')
  const headers = call.init.headers as Record<string, string>
  assert.equal(headers['X-Subscription-Token'], 'key-123')
  // The endpoint host is fixed, so a redirect off it is never legitimate —
  // following one would carry the subscription token wherever it pointed.
  assert.deepEqual(call.options, { maxRedirects: 0 })
  assert.equal(result.results.length, 2)
})

test('an exhausted search quota is reported as such, not as a generic failure', async () => {
  const { guarded } = stubFetch({ status: 429, body: '{"error":"rate limited"}' })
  const client = new ResearchToolClient('key', guarded)
  await assert.rejects(
    () => client.executeTool('', 'web_search', { query: 'acme' }),
    /quota for this workspace is exhausted/,
  )
})

test('an empty query is refused before any request goes out', async () => {
  const { guarded, calls } = stubFetch({ body: BRAVE_PAYLOAD })
  const client = new ResearchToolClient('key', guarded)
  await assert.rejects(() => client.executeTool('', 'web_search', { query: '   ' }), /needs a query/)
  assert.equal(calls.length, 0)
})

test('page text strips script and style BODIES, not just their tags', () => {
  const html = `
    <html><head><style>body { color: red }</style>
    <script>var leak = "should not appear"; if (a < b) {}</script></head>
    <body><h1>Acme raises</h1><p>First paragraph.</p><p>Second paragraph.</p>
    <ul><li>One</li><li>Two</li></ul></body></html>`
  const text = htmlToText(html)
  assert.ok(!text.includes('should not appear'), 'script bodies are removed whole')
  assert.ok(!text.includes('color: red'), 'style bodies are removed whole')
  assert.ok(text.includes('Acme raises'))
  assert.ok(text.includes('First paragraph.'))
  // Block boundaries become newlines so paragraphs do not run together.
  assert.ok(/First paragraph\.\s*\n\s*Second paragraph\./.test(text))
  assert.ok(/One\s*\n\s*Two/.test(text))
})

test('page text decodes the entities that otherwise show up as literals', () => {
  assert.equal(htmlToText('<p>Q&amp;A &lt;here&gt; &quot;now&quot; &#39;x&#39;&nbsp;end</p>'), 'Q&A <here> "now" \'x\' end')
})

test('fetch reports truncation and a non-HTML body is passed through unstripped', async () => {
  const { guarded } = stubFetch({
    body: 'plain,csv,values',
    headers: { 'content-type': 'text/csv' },
  })
  const client = new ResearchToolClient('key', guarded)
  const page = (await client.executeTool('', 'web_fetch', { url: 'https://example.com/data.csv' })) as {
    text: string
    truncated: boolean
    status: number
  }
  assert.equal(page.text, 'plain,csv,values')
  assert.equal(page.truncated, false)
  assert.equal(page.status, 200)
})

test('a page that errors is reported to the model rather than throwing the run', async () => {
  const { guarded } = stubFetch({ status: 404, body: '<html><body>Gone</body></html>', headers: { 'content-type': 'text/html' } })
  const client = new ResearchToolClient('key', guarded)
  const page = (await client.executeTool('', 'web_fetch', { url: 'https://example.com/missing' })) as {
    status: number
    error: string
    text: string
  }
  // A dead link among ten sources should cost one source, not the brief.
  assert.equal(page.status, 404)
  assert.match(page.error, /404/)
  assert.equal(page.text, '')
})

test('the tool surface is two read tools with object schemas and required args', () => {
  const tools = researchTools()
  assert.deepEqual(tools.map((tool) => tool.name), ['web_search', 'web_fetch'])
  for (const tool of tools) {
    assert.equal((tool.inputSchema as { type: string }).type, 'object')
    assert.ok(tool.description.length > 40, 'every tool says when to reach for it')
  }
  const search = tools[0].inputSchema as { required: string[]; properties: Record<string, { enum?: string[] }> }
  assert.deepEqual(search.required, ['query'])
  // The freshness codes are an enum so the model never has to guess one.
  assert.deepEqual(search.properties.freshness.enum, ['past_day', 'past_week', 'past_month', 'past_year'])
})

test('an unknown tool name fails closed', async () => {
  const client = new ResearchToolClient('key', stubFetch({ body: '{}' }).guarded)
  await assert.rejects(() => client.executeTool('', 'web_delete_everything', {}), /Unknown research tool/)
})
