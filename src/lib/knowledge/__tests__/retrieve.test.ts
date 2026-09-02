import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keywordScore, renderKnowledge } from '../retrieve'

test('keywordScore reflects query-term overlap', () => {
  assert.equal(keywordScore('pricing tiers enterprise', 'Our enterprise pricing has three tiers'), 1)
  assert.equal(keywordScore('pricing tiers', 'unrelated content here'), 0)
  assert.ok(keywordScore('pricing tiers', 'pricing information') > 0 && keywordScore('pricing tiers', 'pricing information') < 1)
})

test('renderKnowledge produces an empty string for no hits, a block otherwise', () => {
  assert.equal(renderKnowledge([]), '')
  const block = renderKnowledge([{ content: 'Enterprise tier is $50k', filename: 'pricing.md', score: 0.9 }])
  assert.ok(block.includes('pricing.md'))
  assert.ok(block.includes('Enterprise tier is $50k'))
})

test('renderKnowledge emits a resolvable citation handle, not just a filename', () => {
  const block = renderKnowledge([
    { content: 'Enterprise tier is $50k', filename: 'pricing.md', documentId: 'doc_123', score: 0.9 },
  ])
  assert.ok(block.includes('[doc:doc_123 "pricing.md"]'))
})

test('a hit with no documentId still renders rather than emitting a broken handle', () => {
  const block = renderKnowledge([{ content: 'x', filename: 'pricing.md', score: 0.9 }])
  assert.ok(block.includes('pricing.md'))
  assert.equal(block.includes('[doc:undefined'), false)
})
