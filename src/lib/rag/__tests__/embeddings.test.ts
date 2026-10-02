import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { embedTexts, embedQuery, cosineSimilarity, embeddingsConfigured } from '../embeddings'

const ORIGINAL = { ...process.env }
beforeEach(() => {
  process.env = { ...ORIGINAL }
})

test('embeddingsConfigured reflects VOYAGE_API_KEY', () => {
  delete process.env.VOYAGE_API_KEY
  assert.equal(embeddingsConfigured(), false)
  process.env.VOYAGE_API_KEY = 'pa-x'
  assert.equal(embeddingsConfigured(), true)
})

test('embedTexts posts to Voyage and returns vectors in input order', async () => {
  process.env.VOYAGE_API_KEY = 'pa-test'
  let body: any
  const fetchImpl = (async (_url, init) => {
    body = JSON.parse(String(init?.body))
    // Return out of order to prove we re-order by index.
    return new Response(
      JSON.stringify({ data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch
  const vectors = await embedTexts(['a', 'b'], { fetchImpl, inputType: 'document' })
  assert.deepEqual(vectors, [[1, 0], [0, 1]])
  assert.equal(body.input_type, 'document')
  assert.deepEqual(body.input, ['a', 'b'])
})

test('embedTexts throws a status-tagged error on failure', async () => {
  process.env.VOYAGE_API_KEY = 'pa-test'
  const fetchImpl = (async () => new Response('nope', { status: 429 })) as typeof fetch
  await assert.rejects(embedTexts(['a'], { fetchImpl }), (e: any) => e.status === 429)
})

test('embedTexts on empty input skips the network entirely', async () => {
  process.env.VOYAGE_API_KEY = 'pa-test'
  const fetchImpl = (async () => {
    throw new Error('should not be called')
  }) as typeof fetch
  assert.deepEqual(await embedTexts([], { fetchImpl }), [])
})

test('embedQuery sends input_type=query', async () => {
  process.env.VOYAGE_API_KEY = 'pa-test'
  let body: any
  const fetchImpl = (async (_url, init) => {
    body = JSON.parse(String(init?.body))
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.5, 0.5] }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch
  const v = await embedQuery('find deals at risk', { fetchImpl })
  assert.deepEqual(v, [0.5, 0.5])
  assert.equal(body.input_type, 'query')
})

test('cosineSimilarity: identical=1, orthogonal=0, empty=0', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([], [1]), 0)
  assert.ok(cosineSimilarity([1, 1], [1, 0]) > 0.7 && cosineSimilarity([1, 1], [1, 0]) < 0.72)
})

test('embedding calls carry a bounded provider deadline', async () => {
  process.env.VOYAGE_API_KEY = 'pa-test'
  const fetchImpl = (async (_url, init) => {
    assert.ok(init?.signal)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 500)
      init.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(Error('deadline')) }, { once: true })
    })
    return new Response('{}')
  }) as typeof fetch
  const start = Date.now()
  await assert.rejects(embedTexts(['bounded'], { fetchImpl, timeoutMs: 20 }), /deadline/)
  assert.ok(Date.now() - start < 450)
})
