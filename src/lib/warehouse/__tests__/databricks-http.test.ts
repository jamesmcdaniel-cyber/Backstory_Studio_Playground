import test, { afterEach, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { __setSsrfResolver, clearPins } from '@/lib/net/ssrf'
import type { ResolvedHttpCredential } from '@/features/flows/http-auth'
import { credentialedWarehouseRequest } from '../http'
import { downloadVolumeFile, uploadVolumeFile, volumeTarget } from '../databricks-api'

/**
 * The real credentialed request — credential, SSRF guard, redirect refusal,
 * byte bodies and the streaming size cap — over a fake fetch. The resolver is
 * swapped for a public answer, so no DNS query or connection is ever made.
 */

const HOST = 'dbc-1.cloud.databricks.com'
const credential: ResolvedHttpCredential = { id: 'c', name: 'Databricks', authType: 'bearer', allowedHost: HOST, config: { token: 'dapi-secret' } }

beforeEach(() => {
  clearPins()
  __setSsrfResolver(async () => [{ address: '93.184.216.34', family: 4 }])
})
afterEach(() => {
  __setSsrfResolver(null)
  clearPins()
})

type Seen = { url: string; method?: string; headers: Record<string, string>; body?: Uint8Array }

function fakeFetch(respond: (seen: Seen) => Response) {
  const seen: Seen[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value })
    const body = init?.body instanceof Blob ? new Uint8Array(await init.body.arrayBuffer()) : typeof init?.body === 'string' ? new TextEncoder().encode(init.body) : undefined
    const entry = { url: String(input), method: init?.method, headers, ...(body ? { body } : {}) }
    seen.push(entry)
    return respond(entry)
  }) as typeof fetch
  return { fetchImpl, seen }
}

/** A body that streams `chunks` × `size` bytes and counts how many chunks were pulled. */
function countingStream(chunks: number, size: number) {
  const state = { pulled: 0 }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) return controller.close()
      state.pulled += 1
      controller.enqueue(new Uint8Array(size).fill(65))
    },
  })
  return { stream, state }
}

test('an upload sends the exact bytes with its content type and the bearer credential, to the volume path', async () => {
  const net = fakeFetch(() => new Response(null, { status: 204 }))
  const request = credentialedWarehouseRequest(HOST, credential, { label: 'Databricks response', fetchImpl: net.fetchImpl })
  const pooled = new Uint8Array(Buffer.from('xxhello, volumexx')).subarray(2, 15)
  await uploadVolumeFile(request, volumeTarget({ volumePath: 'main.default.landing', inner: 'in/note.txt' }, 'file'), pooled, { contentType: 'text/plain', overwrite: false })
  const [call] = net.seen
  assert.equal(call.url, `https://${HOST}/api/2.0/fs/files/Volumes/main/default/landing/in/note.txt?overwrite=false`)
  assert.equal(call.method, 'PUT')
  assert.equal(call.headers.authorization, 'Bearer dapi-secret')
  assert.equal(call.headers['content-type'], 'text/plain')
  assert.equal(new TextDecoder().decode(call.body), 'hello, volume', 'only the viewed bytes, not the pool around them')
})

test('a download streams under its cap and is cut off mid-stream once it passes it', async () => {
  const small = countingStream(3, 1000)
  const ok = fakeFetch(() => new Response(small.stream, { status: 200, headers: { 'content-type': 'text/csv' } }))
  const file = await downloadVolumeFile(credentialedWarehouseRequest(HOST, credential, { label: 'Downloaded file', fetchImpl: ok.fetchImpl }), volumeTarget({ volumePath: 'a.b.c', inner: 'x.csv' }, 'file'), 5000)
  assert.equal(file.bytes.byteLength, 3000)
  assert.equal(file.contentType, 'text/csv')

  const huge = countingStream(10_000, 1000)
  const big = fakeFetch(() => new Response(huge.stream, { status: 200 }))
  await assert.rejects(
    downloadVolumeFile(credentialedWarehouseRequest(HOST, credential, { label: 'Downloaded file', fetchImpl: big.fetchImpl }), volumeTarget({ volumePath: 'a.b.c', inner: 'big.bin' }, 'file'), 5000),
    /Downloaded file exceeded 5000 bytes/,
  )
  assert.ok(huge.state.pulled < 20, `stopped reading early (pulled ${huge.state.pulled} of 10000 chunks)`)

  const declared = fakeFetch(() => new Response(countingStream(1, 10).stream, { status: 200, headers: { 'content-length': '999999999' } }))
  await assert.rejects(
    downloadVolumeFile(credentialedWarehouseRequest(HOST, credential, { label: 'Downloaded file', fetchImpl: declared.fetchImpl }), volumeTarget({ volumePath: 'a.b.c', inner: 'big.bin' }, 'file'), 5000),
    /exceeded 5000 bytes/,
    'a declared length over the cap is refused before reading',
  )
})

test('the per-call cap can only tighten the request\'s own ceiling; error bodies stay small text', async () => {
  const net = fakeFetch(() => new Response(countingStream(5, 1000).stream, { status: 200 }))
  const request = credentialedWarehouseRequest(HOST, credential, { label: 'r', maxBytes: 2000, fetchImpl: net.fetchImpl })
  await assert.rejects(request('/api/2.0/fs/files/Volumes/a/b/c/x', { method: 'GET', binary: true, maxBytes: 1_000_000 }), /exceeded 2000 bytes/)

  const failing = fakeFetch(() => new Response('{"error_code":"NOT_FOUND","message":"no such file"}', { status: 404 }))
  const response = await credentialedWarehouseRequest(HOST, credential, { label: 'r', fetchImpl: failing.fetchImpl })('/api/2.0/fs/files/Volumes/a/b/c/x', { method: 'GET', binary: true })
  assert.deepEqual([response.ok, response.bytes, JSON.parse(response.text).error_code], [false, undefined, 'NOT_FOUND'])
})

test('a redirect is refused (the credential never follows it) and a private address is never dialled', async () => {
  const bounce = fakeFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } }))
  await assert.rejects(credentialedWarehouseRequest(HOST, credential, { label: 'r', fetchImpl: bounce.fetchImpl })('/api/2.0/genie/spaces/s', { method: 'GET' }), /Redirects are not allowed/)
  assert.equal(bounce.seen.length, 1)

  __setSsrfResolver(async () => [{ address: '10.0.0.5', family: 4 }])
  clearPins()
  const internal = fakeFetch(() => new Response('{}'))
  await assert.rejects(credentialedWarehouseRequest(HOST, credential, { label: 'r', fetchImpl: internal.fetchImpl })('/api/2.0/serving-endpoints', { method: 'GET' }), /private or reserved/)
  assert.equal(internal.seen.length, 0)

  await assert.rejects(credentialedWarehouseRequest('evil.example.com', credential, { label: 'r', fetchImpl: internal.fetchImpl })('/x', { method: 'GET' }), /restricted to dbc-1\.cloud\.databricks\.com/)
})
