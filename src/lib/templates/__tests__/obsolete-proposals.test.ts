import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isResolved, proposalTarget } from '../obsolete-proposals'

test('enough clean runs since the complaint means it is resolved', () => {
  assert.equal(isResolved({ completed: 3, failed: 0 }), true)
  assert.equal(isResolved({ completed: 50, failed: 0 }), true)
})

test('one lucky success does not retire a recurring problem', () => {
  assert.equal(isResolved({ completed: 1, failed: 0 }), false)
  assert.equal(isResolved({ completed: 2, failed: 0 }), false)
})

test('a single failure since it was raised keeps it open, however many successes', () => {
  assert.equal(isResolved({ completed: 99, failed: 1 }), false)
})

test('a target that has not run again keeps its proposal — silence is not a fix', () => {
  assert.equal(isResolved({ completed: 0, failed: 0 }), false)
})

test('the threshold is adjustable for callers that want a stricter bar', () => {
  assert.equal(isResolved({ completed: 3, failed: 0 }, 10), false)
  assert.equal(isResolved({ completed: 10, failed: 0 }, 10), true)
})

test('reads a well-formed target off the configuration', () => {
  assert.deepEqual(proposalTarget({ targetType: 'flow', targetId: 'flow-1' }), { type: 'flow', id: 'flow-1' })
  assert.deepEqual(proposalTarget({ targetType: 'agent', targetId: ' a-1 ' }), { type: 'agent', id: 'a-1' })
})

test('anything malformed yields no target, so the sweep skips it rather than guessing', () => {
  for (const configuration of [null, undefined, {}, [], 'nope', 42,
    { targetType: 'flow' },
    { targetId: 'x' },
    { targetType: 'workflow', targetId: 'x' },
    { targetType: 'flow', targetId: '' },
    { targetType: 'flow', targetId: 7 },
  ]) {
    assert.equal(proposalTarget(configuration), null, `configuration ${JSON.stringify(configuration)}`)
  }
})
