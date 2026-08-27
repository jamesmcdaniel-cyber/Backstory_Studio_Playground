import test from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import {
  boundedNextRequest,
  readRequestBytesLimited,
  readRequestJsonLimited,
  RequestBodyError,
} from '../request-body'

function chunkedRequest(chunks: string[], headers?: HeadersInit): Request {
  const encoder = new TextEncoder()
  return new Request('http://test/body', {
    method: 'POST',
    headers,
    body: new ReadableStream({
      pull(controller) {
        const next = chunks.shift()
        if (next === undefined) controller.close()
        else controller.enqueue(encoder.encode(next))
      },
    }),
    duplex: 'half',
  } as RequestInit)
}

test('actual streamed bytes are bounded when Content-Length is omitted', async () => {
  await assert.rejects(
    () => readRequestBytesLimited(chunkedRequest(['1234', '5678']), 7),
    (error: unknown) => error instanceof RequestBodyError && error.status === 413,
  )
})

test('a false small Content-Length cannot bypass the streamed limit', async () => {
  await assert.rejects(
    () => readRequestBytesLimited(chunkedRequest(['1234', '5678'], { 'content-length': '1' }), 7),
    (error: unknown) => error instanceof RequestBodyError && error.code === 'BODY_TOO_LARGE',
  )
})

test('JSON parsing rejects unsupported media types and malformed JSON', async () => {
  await assert.rejects(
    () => readRequestJsonLimited(chunkedRequest(['{}'], { 'content-type': 'text/plain' }), 100),
    (error: unknown) => error instanceof RequestBodyError && error.status === 415,
  )
  await assert.rejects(
    () => readRequestJsonLimited(chunkedRequest(['{'], { 'content-type': 'application/json' }), 100),
    (error: unknown) => error instanceof RequestBodyError && error.code === 'INVALID_BODY',
  )
})

test('boundedNextRequest preserves a body for existing handler parsers', async () => {
  const request = new NextRequest('http://test/body', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  })
  const bounded = await boundedNextRequest(request, 100)
  assert.deepEqual(await bounded.json(), { ok: true })
  assert.equal(bounded.headers.get('content-length'), '11')
})
