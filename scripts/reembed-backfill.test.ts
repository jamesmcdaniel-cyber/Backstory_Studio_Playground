/**
 * Unit tests for the pure decision logic in scripts/reembed-backfill.ts —
 * which action a row needs (convert / re-embed / skip), legacy-vector
 * dimension validation, and batching. No live DB, no provider call: these
 * exercise the exported pure functions directly.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test scripts/reembed-backfill.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunk, decideAction, estimateTokens, isValidLegacyVector, type BackfillRow } from './reembed-backfill'

const DIM = 1024
const validVector = () => Array.from({ length: DIM }, (_, i) => i / DIM)

test('isValidLegacyVector: accepts a number[] of exactly the right dimension', () => {
  assert.equal(isValidLegacyVector(validVector(), DIM), true)
})

test('isValidLegacyVector: rejects null / undefined / non-array', () => {
  assert.equal(isValidLegacyVector(null, DIM), false)
  assert.equal(isValidLegacyVector(undefined, DIM), false)
  assert.equal(isValidLegacyVector('not-an-array', DIM), false)
  assert.equal(isValidLegacyVector({ 0: 1, 1: 2 }, DIM), false)
})

test('isValidLegacyVector: rejects wrong length (short and long)', () => {
  assert.equal(isValidLegacyVector(validVector().slice(0, DIM - 1), DIM), false)
  assert.equal(isValidLegacyVector([...validVector(), 0.5], DIM), false)
  assert.equal(isValidLegacyVector([], DIM), false)
})

test('isValidLegacyVector: rejects an array with non-finite or non-number entries', () => {
  const withNaN = validVector()
  withNaN[10] = NaN
  assert.equal(isValidLegacyVector(withNaN, DIM), false)

  const withInfinity = validVector()
  withInfinity[10] = Infinity
  assert.equal(isValidLegacyVector(withInfinity, DIM), false)

  const withString = validVector() as unknown[]
  withString[10] = '0.5'
  assert.equal(isValidLegacyVector(withString, DIM), false)
})

test('decideAction: a valid legacy vector wins over re-embedding (cheaper path preferred)', () => {
  const row: BackfillRow = { id: '1', text: 'some content to embed', legacyEmbedding: validVector() }
  assert.equal(decideAction(row, DIM), 'convert')
})

test('decideAction: no usable legacy value but text present -> reembed', () => {
  const cases: BackfillRow[] = [
    { id: '1', text: 'hello world', legacyEmbedding: null },
    { id: '2', text: 'hello world', legacyEmbedding: undefined },
    { id: '3', text: 'hello world', legacyEmbedding: [1, 2, 3] }, // wrong dimension
    { id: '4', text: 'hello world', legacyEmbedding: 'garbage' },
  ]
  for (const row of cases) assert.equal(decideAction(row, DIM), 'reembed', `row ${row.id} should reembed`)
})

test('decideAction: no usable legacy value and no text -> skip', () => {
  assert.equal(decideAction({ id: '1', text: '', legacyEmbedding: null }, DIM), 'skip')
  assert.equal(decideAction({ id: '2', text: '   ', legacyEmbedding: null }, DIM), 'skip') // whitespace-only text is not usable
})

test('decideAction: default dimension parameter matches the app-wide EMBEDDING_DIM (1024)', () => {
  const row: BackfillRow = { id: '1', text: 'x', legacyEmbedding: validVector() }
  assert.equal(decideAction(row), 'convert')
})

test('chunk: splits into stable, order-preserving batches', () => {
  const ids = ['a', 'b', 'c', 'd', 'e']
  assert.deepEqual(chunk(ids, 2), [['a', 'b'], ['c', 'd'], ['e']])
  assert.deepEqual(chunk(ids, 5), [['a', 'b', 'c', 'd', 'e']])
  assert.deepEqual(chunk(ids, 100), [['a', 'b', 'c', 'd', 'e']])
})

test('chunk: empty input yields no batches', () => {
  assert.deepEqual(chunk([], 10), [])
})

test('chunk: rejects a non-positive size', () => {
  assert.throws(() => chunk([1, 2, 3], 0))
  assert.throws(() => chunk([1, 2, 3], -1))
})

test('estimateTokens: roughly 4 chars per token, monotonic in length', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 1)
  assert.equal(estimateTokens('abcde'), 2)
  assert.ok(estimateTokens('a'.repeat(4000)) > estimateTokens('a'.repeat(400)))
})

// --- A tiny in-memory stand-in for the DB + provider seam, proving the
// batching/decision logic composes the way the driver in reembed-backfill.ts
// relies on, without importing systemPrisma or hitting Voyage. ---

interface FakeRow {
  id: string
  content: string
  embedding: unknown
}

function fakeDecideAndBatch(rows: FakeRow[], batchSize: number) {
  const decided = rows.map((r) => ({
    id: r.id,
    action: decideAction({ id: r.id, text: r.content, legacyEmbedding: r.embedding }, DIM),
  }))
  const reembedIds = decided.filter((d) => d.action === 'reembed').map((d) => d.id)
  const batches = chunk(reembedIds, batchSize)
  return { decided, batches }
}

test('integration of decideAction + chunk: mixed convert/reembed/skip rows batch correctly', () => {
  const rows: FakeRow[] = [
    { id: '1', content: 'has legacy', embedding: validVector() }, // convert
    { id: '2', content: 'no legacy, has text', embedding: null }, // reembed
    { id: '3', content: '', embedding: null }, // skip
    { id: '4', content: 'bad legacy dim', embedding: [1, 2] }, // reembed
    { id: '5', content: 'another good legacy', embedding: validVector() }, // convert
  ]
  const { decided, batches } = fakeDecideAndBatch(rows, 2)
  assert.deepEqual(
    decided.map((d) => d.action),
    ['convert', 'reembed', 'skip', 'reembed', 'convert'],
  )
  assert.deepEqual(batches, [['2', '4']])
})
