import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bestAnswerMatch,
  renderAgentMemories,
  MEMORY_SIMILARITY_THRESHOLD,
  MEMORY_INJECTION_LIMIT,
  memoryFingerprint,
  memoryScopeFilter,
} from '../agent-memory'

const vec = (x: number, y: number) => [x, y]

test('bestAnswerMatch picks the closest embedded question above 0.86', () => {
  const candidates = [
    { id: 'm1', question: 'Which region should I focus on?', content: 'EMEA', embedding: vec(1, 0) },
    { id: 'm2', question: 'What is the pipeline threshold?', content: '$50k', embedding: vec(0, 1) },
  ]
  const hit = bestAnswerMatch(vec(0.99, 0.05), 'Which region?', candidates)
  assert.equal(hit?.id, 'm1')
  assert.equal(hit?.content, 'EMEA')
  assert.ok(hit!.score >= MEMORY_SIMILARITY_THRESHOLD)
})

test('bestAnswerMatch returns null below the threshold', () => {
  const candidates = [{ id: 'm1', question: 'Which region?', content: 'EMEA', embedding: vec(1, 0) }]
  assert.equal(bestAnswerMatch(vec(0.5, 0.87), 'unrelated', candidates), null)
})

test('bestAnswerMatch falls back to keyword overlap without vectors', () => {
  const candidates = [
    { id: 'm1', question: 'Which Salesforce region should the report cover?', content: 'EMEA', embedding: null },
  ]
  const hit = bestAnswerMatch(null, 'Which Salesforce region should this cover?', candidates)
  assert.equal(hit?.id, 'm1')
  assert.equal(bestAnswerMatch(null, 'completely different topic entirely', candidates), null)
})

test('renderAgentMemories renders headings, caps, and critique', () => {
  const hits = Array.from({ length: 8 }, (_, i) => ({
    id: `m${i}`, kind: 'learning', title: `T${i}`, content: `Learned ${i}`, question: null, score: 1 - i / 10,
  }))
  const block = renderAgentMemories(hits.slice(0, MEMORY_INJECTION_LIMIT), 'Do fewer tool calls next time.')
  assert.match(block, /## What you've learned \(from previous runs\)/)
  assert.match(block, /Learned 0/)
  assert.match(block, /## Notes to self from last run/)
  assert.match(block, /fewer tool calls/)
  assert.equal(renderAgentMemories([], null), '')
  assert.match(renderAgentMemories([], 'note'), /## Notes to self from last run/)
})

// ── Resource scoping ───────────────────────────────────────────────────────

test('a scoped recall reads the resource AND what the agent knows generally', () => {
  // Narrowing to one account must not make the agent forget everything it has
  // learned about the job — that would be worse than not scoping at all.
  assert.deepEqual(memoryScopeFilter('acct_123'), {
    OR: [{ resourceId: 'acct_123' }, { resourceId: null }],
  })
})

test('an unscoped recall is unchanged — no filter at all', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.deepEqual(memoryScopeFilter(value), {}, JSON.stringify(value))
  }
})

test('the same learning fingerprints the same through trivial differences', () => {
  const base = memoryFingerprint('Renewal cadence', 'Acme reviews budget in Q3.')
  assert.equal(base, memoryFingerprint('renewal   cadence', 'Acme reviews budget in Q3'))
  assert.equal(base, memoryFingerprint('Renewal cadence ', ' Acme reviews budget in Q3. '))
})

test('a different learning fingerprints differently', () => {
  assert.notEqual(
    memoryFingerprint('Renewal cadence', 'Acme reviews budget in Q3.'),
    memoryFingerprint('Renewal cadence', 'Acme reviews budget in Q4.'),
  )
  // The title is part of the identity: the same sentence filed under a
  // different heading is a different memory.
  assert.notEqual(
    memoryFingerprint('Renewal cadence', 'Same body.'),
    memoryFingerprint('Buying committee', 'Same body.'),
  )
})

test('the fingerprint separates title from content — no boundary collision', () => {
  // Concatenating without a separator would make ("ab","c") and ("a","bc") the
  // same memory.
  assert.notEqual(memoryFingerprint('ab', 'c'), memoryFingerprint('a', 'bc'))
})
