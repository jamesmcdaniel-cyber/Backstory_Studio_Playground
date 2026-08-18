/**
 * The builder's "follow redirects" switch, end to end.
 *
 * The control existed on the http step and wrote `followRedirects` into the
 * node's data, but `interpretFlow` never copied it into the adapter config —
 * so every flow HTTP step ran as `redirect: 'error'` no matter what the author
 * chose, and the toggle silently did nothing.
 *
 * These tests drive the whole real path: node data -> interpretFlow ->
 * prepareHttpRequest -> fetchWithHttpCredential, with only DNS and the socket
 * stubbed. That is what makes them able to catch the pass-through going missing
 * again, and what proves the outbound guard still validates and pins EVERY hop
 * once redirects are on.
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { interpretFlow, type RunActionFn, type RunAgentFn } from '../interpret'
import { prepareHttpRequest } from '../http'
import { fetchWithHttpCredential } from '../http-auth'
import { __setSsrfResolver, clearPins } from '@/lib/net/ssrf'
import type { FlowGraph } from '@/lib/flows/graph'

const ADDRESSES: Record<string, string> = {
  'start.example.com': '93.184.216.34',
  'hop2.example.com': '93.184.216.35',
  'metadata.example.com': '169.254.169.254', // link-local: must never be dialled
}

/** These graphs contain no agent step; a call here is a bug in the test. */
const neverRunsAgent: RunAgentFn = async () => {
  throw new Error('no agent step in this graph')
}

const realFetch = globalThis.fetch
let dialled: string[] = []

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

/**
 * Run a one-step http flow and perform the request the way the executor does:
 * the config interpretFlow produces, through prepareHttpRequest, through the
 * single outbound seam.
 */
async function runHttpNode(data: Record<string, unknown>): Promise<Response> {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'call', type: 'http', data },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'call' }],
  } as unknown as FlowGraph

  let config: Record<string, unknown> | undefined
  const runAction: RunActionFn = async (node) => {
    config = node.config
    return { output: { ok: true } }
  }
  const result = await interpretFlow(graph, 'go', { runAgent: neverRunsAgent, runAction })
  assert.equal(result.status, 'succeeded')
  assert.ok(config, 'the http step produced no adapter config')

  const request = prepareHttpRequest(config as Parameters<typeof prepareHttpRequest>[0])
  return fetchWithHttpCredential(request, null)
}

test('a node with redirects enabled follows a public hop', async () => {
  serve({
    'https://start.example.com/go': { status: 302, location: 'https://hop2.example.com/final' },
    'https://hop2.example.com/final': { status: 200, body: 'arrived' },
  })
  const response = await runHttpNode({ method: 'GET', url: 'https://start.example.com/go', followRedirects: true })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'arrived')
  assert.deepEqual(dialled, ['https://start.example.com/go', 'https://hop2.example.com/final'])
})

test("a node's maxRedirects still caps the chain it is allowed to follow", async () => {
  serve({
    'https://start.example.com/go': { status: 302, location: 'https://hop2.example.com/final' },
    'https://hop2.example.com/final': { status: 200, body: 'arrived' },
  })
  const response = await runHttpNode({
    method: 'GET',
    url: 'https://start.example.com/go',
    followRedirects: true,
    maxRedirects: 0,
  })
  assert.equal(response.status, 302) // handed back unfollowed
  assert.deepEqual(dialled, ['https://start.example.com/go'])
})

test('a node with redirects enabled is still refused when a hop targets a link-local address', async () => {
  serve({
    'https://start.example.com/go': { status: 302, location: 'https://metadata.example.com/latest/meta-data/' },
  })
  await assert.rejects(
    () => runHttpNode({ method: 'GET', url: 'https://start.example.com/go', followRedirects: true }),
    /private or reserved address/,
  )
  // The refusal happens BEFORE the socket: the metadata host is never dialled.
  assert.deepEqual(dialled, ['https://start.example.com/go'])
})

test('a node with the field unset keeps erroring on a 3xx exactly as before', async () => {
  serve({
    'https://start.example.com/go': { status: 302, location: 'https://hop2.example.com/final' },
    'https://hop2.example.com/final': { status: 200, body: 'arrived' },
  })
  await assert.rejects(
    () => runHttpNode({ method: 'GET', url: 'https://start.example.com/go' }),
    /not allowed/,
  )
  assert.deepEqual(dialled, ['https://start.example.com/go'])
})

test('an http node emits no redirect keys unless its author set them', async () => {
  const graph = {
    nodes: [
      { id: 'trigger', type: 'trigger', data: {} },
      { id: 'call', type: 'http', data: { method: 'GET', url: 'https://start.example.com/go' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'call' }],
  } as unknown as FlowGraph
  let config: Record<string, unknown> | undefined
  await interpretFlow(graph, 'go', {
    runAgent: neverRunsAgent,
    runAction: async (node) => {
      config = node.config
      return { output: {} }
    },
  })
  assert.equal('followRedirects' in (config ?? {}), false)
  assert.equal('maxRedirects' in (config ?? {}), false)
})
