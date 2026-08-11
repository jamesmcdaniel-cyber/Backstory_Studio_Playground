import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runScopeKey, LEDGER_REPLAY_WARNING } from '../side-effect-ledger'
import { flowSideEffectKey } from '../idempotency'

/**
 * The scope is what decides whether two runs share replay protection. A normal
 * run scopes by itself; a poll run scopes by the ITEM it was dispatched for,
 * because poll-dispatch.ts dispatches before persisting its cursor — so a crash
 * between the two re-emits the same item as a brand new run.
 */

test('a normal run scopes by its own run id', () => {
  const key = runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'schedule' } })
  assert.equal(key, 'run-1')
})

test('a poll run scopes by flow + dedupe value, so a re-emitted item shares keys', () => {
  const a = runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-42' } })
  const b = runScopeKey({ id: 'run-2', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-42' } })
  assert.equal(a, 'flow-1:item-42')
  assert.equal(a, b)
})

test('a poll run with no dedupe value falls back to the run id rather than colliding', () => {
  // The batch-dispatch shape: one run for the whole poll, no single item to key on.
  assert.equal(runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll' } }), 'run-1')
  assert.equal(runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: '  ' } }), 'run-1')
})

test('different polled items never share a scope', () => {
  const a = runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-1' } })
  const b = runScopeKey({ id: 'run-2', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-2' } })
  assert.notEqual(a, b)
})

test('the same item polled by DIFFERENT flows does not share a scope', () => {
  const a = runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-1' } })
  const b = runScopeKey({ id: 'run-2', flowId: 'flow-2', trigger: { type: 'poll', dedupeValue: 'item-1' } })
  assert.notEqual(a, b)
})

test('a malformed trigger degrades to the run id instead of throwing', () => {
  assert.equal(runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: null }), 'run-1')
  assert.equal(runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: 'nonsense' }), 'run-1')
  assert.equal(runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 7 } }), 'run-1')
})

test('the header key is derived from the same scope, so ledger and header agree', () => {
  const scope = runScopeKey({ id: 'run-1', flowId: 'flow-1', trigger: { type: 'poll', dedupeValue: 'item-42' } })
  assert.equal(flowSideEffectKey(scope, 'send', 0), flowSideEffectKey('flow-1:item-42', 'send', 0))
})

test('existing run-scoped keys are unchanged — no behavior drift for non-poll runs', () => {
  assert.equal(flowSideEffectKey('run-1', 'send', 0), flowSideEffectKey('run-1', 'send'))
  assert.match(flowSideEffectKey('run-1', 'send'), /^bs_[0-9a-f]{64}$/)
})

test('page participates in the key, so paginated writes do not collide', () => {
  assert.notEqual(flowSideEffectKey('run-1', 'fetch', 0), flowSideEffectKey('run-1', 'fetch', 1))
})

test('the replay warning names the fact plainly, with no token syntax', () => {
  assert.match(LEDGER_REPLAY_WARNING, /replay/i)
  assert.ok(!LEDGER_REPLAY_WARNING.includes('{{'))
})
