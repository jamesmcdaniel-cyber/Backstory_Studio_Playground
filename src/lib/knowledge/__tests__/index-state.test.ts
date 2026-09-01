import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveIndexState } from '../index-state'

test('a document with no chunks yet is pending', () => {
  assert.equal(deriveIndexState(0, 0), 'pending')
})

test('chunks with no vectors at all are unindexed', () => {
  assert.equal(deriveIndexState(5, 0), 'unindexed')
})

test('some vectors missing is partial', () => {
  assert.equal(deriveIndexState(5, 3), 'partial')
})

test('every chunk embedded is indexed', () => {
  assert.equal(deriveIndexState(5, 5), 'indexed')
})

test('more embedded than counted never reports partial', () => {
  // Defensive: a racing sweep can report a higher embedded count than the
  // snapshot total. Clamp rather than emit a nonsense state.
  assert.equal(deriveIndexState(5, 6), 'indexed')
})
