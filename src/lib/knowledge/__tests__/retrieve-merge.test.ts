import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeHits, KEYWORD_ADMISSION_SCORE, type KnowledgeHit } from '../retrieve'

const vec = (id: string, score: number): KnowledgeHit =>
  ({ content: `v-${id}`, filename: `${id}.md`, documentId: id, score, matchedBy: 'vector' })
const kw = (id: string, score: number): KnowledgeHit =>
  ({ content: `k-${id}`, filename: `${id}.md`, documentId: id, score, matchedBy: 'keyword' })

test('vector hits fill the result set first', () => {
  const merged = mergeHits([vec('a', 0.9), vec('b', 0.8)], [kw('c', 1)], 2)
  assert.deepEqual(merged.map((h) => h.documentId), ['a', 'b'])
})

test('keyword hits only fill remaining slots', () => {
  const merged = mergeHits([vec('a', 0.9)], [kw('c', 1)], 3)
  assert.deepEqual(merged.map((h) => h.documentId), ['a', 'c'])
  assert.equal(merged[1].matchedBy, 'keyword')
})

test('keyword hits below the admission score are dropped', () => {
  const merged = mergeHits([], [kw('c', KEYWORD_ADMISSION_SCORE - 0.01)], 5)
  assert.deepEqual(merged, [])
})

test('a keyword hit never displaces a vector hit', () => {
  const merged = mergeHits([vec('a', 0.4)], [kw('c', 1)], 1)
  assert.deepEqual(merged.map((h) => h.documentId), ['a'])
})

test('the same passage is not returned twice', () => {
  const dup: KnowledgeHit = { content: 'same', filename: 'a.md', documentId: 'a', score: 0.9, matchedBy: 'vector' }
  const merged = mergeHits([dup], [{ ...dup, score: 1, matchedBy: 'keyword' }], 5)
  assert.equal(merged.length, 1)
})
