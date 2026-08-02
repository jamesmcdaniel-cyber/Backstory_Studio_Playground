import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setErrorReporter, resetErrorReporter } from '@/lib/observability/sentry'
import { transcriptionAvailable, transcribeSegment } from '../huddle-transcribe'

const AUDIO = new Uint8Array([1, 2, 3])

test('transcription is available only with an OpenAI key', () => {
  assert.equal(transcriptionAvailable({ OPENAI_API_KEY: 'sk-x' }), true)
  assert.equal(transcriptionAvailable({}), false)
  assert.equal(transcriptionAvailable({ OPENAI_API_KEY: '' }), false)
})

test('a segment is posted as multipart with the key and model, returning the text', async () => {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ text: ' add a slack step ' }) } as unknown as Response
  }) as unknown as typeof fetch

  const text = await transcribeSegment(
    { audio: AUDIO, mimeType: 'audio/webm', env: { OPENAI_API_KEY: 'sk-x' }, fetchImpl },
  )
  assert.equal(text, 'add a slack step')
  assert.match(calls[0].url, /api\.openai\.com\/v1\/audio\/transcriptions$/)
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers.Authorization, 'Bearer sk-x')
  const body = calls[0].init.body as FormData
  assert.equal(body.get('model'), 'whisper-1')
  assert.ok(body.get('file') instanceof Blob)
})

test('an upstream failure returns null rather than throwing into the route', async () => {
  setErrorReporter(() => {})
  const failing = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch
  assert.equal(await transcribeSegment({ audio: AUDIO, mimeType: 'audio/webm', env: { OPENAI_API_KEY: 'sk-x' }, fetchImpl: failing }), null)
  const throwing = (async () => { throw new Error('network') }) as unknown as typeof fetch
  assert.equal(await transcribeSegment({ audio: AUDIO, mimeType: 'audio/webm', env: { OPENAI_API_KEY: 'sk-x' }, fetchImpl: throwing }), null)
  resetErrorReporter()
})

test('without a key it returns null without calling anyone', async () => {
  let called = false
  const spy = (async () => { called = true; return {} as Response }) as unknown as typeof fetch
  assert.equal(await transcribeSegment({ audio: AUDIO, mimeType: 'audio/webm', env: {}, fetchImpl: spy }), null)
  assert.equal(called, false)
})
