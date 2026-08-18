/**
 * Redirect hops on the flow HTTP step are attacker-influenced: the FIRST URL
 * can be perfectly public and still bounce the request to a link-local
 * metadata address. `fetchWithHttpCredential` is the single outbound seam every
 * flow HTTP step uses, so every hop it takes — the first request, a digest
 * re-try, and each redirect target — is validated and pinned before it is
 * dialled.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { fetchWithHttpCredential } from '../http-auth'
import { __setSsrfResolver, clearPins } from '@/lib/net/ssrf'

// Where each host "resolves" — the seam a rebinding attacker controls.
const ADDRESSES: Record<string, string> = {
  'start.example.com': '93.184.216.34',
  'hop2.example.com': '93.184.216.35',
  'hop3.example.com': '93.184.216.36',
  'metadata.example.com': '169.254.169.254', // link-local: must never be dialled
}

const realFetch = globalThis.fetch
let dialled: string[] = []

/** Serve a canned redirect chain; record every URL actually requested. */
function serve(routes: Record<string, { status: number; location?: string; body?: string }>) {
  globalThis.fetch = (async (url: string | URL) => {
    const key = String(url)
    dialled.push(key)
    const route = routes[key]
    if (!route) return new Response('not found', { status: 404 })
    return new Response(route.body ?? '', {
      status: route.status,
      headers: route.location ? { location: route.location } : {},
    })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  dialled = []
  clearPins()
  __setSsrfResolver(async (host) => {
    const address = ADDRESSES[host]
    if (!address) throw new Error(`unknown host ${host}`)
    return [{ address, family: 4 as const }]
  })
})

afterEach(() => {
  globalThis.fetch = realFetch
  __setSsrfResolver(null)
  clearPins()
})

const request = (url: string, over: Record<string, unknown> = {}) => ({
  url,
  init: { method: 'GET', headers: { authorization: 'Bearer secret' }, redirect: 'manual' as RequestRedirect },
  followRedirects: true,
  ...over,
})

test('a redirect to a link-local address is refused, and never dialled', async () => {
  serve({
    'https://start.example.com/go': { status: 302, location: 'https://metadata.example.com/latest/meta-data/' },
  })
  await assert.rejects(
    () => fetchWithHttpCredential(request('https://start.example.com/go'), null),
    /private or reserved address/,
  )
  assert.deepEqual(dialled, ['https://start.example.com/go'])
})

test('a multi-hop redirect between public hosts still succeeds', async () => {
  serve({
    'https://start.example.com/go': { status: 302, location: 'https://hop2.example.com/next' },
    'https://hop2.example.com/next': { status: 302, location: 'https://hop3.example.com/final' },
    'https://hop3.example.com/final': { status: 200, body: 'arrived' },
  })
  const response = await fetchWithHttpCredential(request('https://start.example.com/go'), null)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'arrived')
  assert.deepEqual(dialled, [
    'https://start.example.com/go',
    'https://hop2.example.com/next',
    'https://hop3.example.com/final',
  ])
})

test('the hop limit still caps the chain', async () => {
  serve({
    'https://start.example.com/go': { status: 302, location: 'https://hop2.example.com/next' },
    'https://hop2.example.com/next': { status: 302, location: 'https://hop3.example.com/final' },
    'https://hop3.example.com/final': { status: 200, body: 'arrived' },
  })
  const response = await fetchWithHttpCredential(request('https://start.example.com/go', { maxRedirects: 1 }), null)
  assert.equal(response.status, 302) // stopped one hop in, unfollowed
  assert.equal(dialled.length, 2)
})

test('with redirects off, a redirect is an error rather than a followed hop', async () => {
  serve({
    'https://start.example.com/go': { status: 302, location: 'https://metadata.example.com/latest/meta-data/' },
  })
  await assert.rejects(
    () =>
      fetchWithHttpCredential(
        { url: 'https://start.example.com/go', init: { method: 'GET', redirect: 'error' }, followRedirects: false },
        null,
      ),
    /not allowed/,
  )
  assert.deepEqual(dialled, ['https://start.example.com/go'])
})

test('a request that never redirects is untouched', async () => {
  serve({ 'https://start.example.com/data': { status: 200, body: 'ok' } })
  const response = await fetchWithHttpCredential(
    { url: 'https://start.example.com/data', init: { method: 'GET' }, followRedirects: false },
    null,
  )
  assert.equal(await response.text(), 'ok')
})

test('the guard refuses a host that resolves only to a private address up front', async () => {
  serve({ 'https://metadata.example.com/latest/': { status: 200, body: 'secrets' } })
  await assert.rejects(
    () =>
      fetchWithHttpCredential(
        { url: 'https://metadata.example.com/latest/', init: { method: 'GET' }, followRedirects: false },
        null,
      ),
    /private or reserved address/,
  )
  assert.deepEqual(dialled, [])
})
