import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldGuardFlowWrite } from '../concurrency'

test('full-graph writes use the optimistic concurrency guard', () => {
  assert.equal(shouldGuardFlowWrite({ graph: { nodes: [], edges: [] }, baseUpdatedAt: '2026-08-21T00:00:00.000Z' }), true)
})

test('settings-only writes do not race a pending graph autosave', () => {
  assert.equal(shouldGuardFlowWrite({ graph: undefined, baseUpdatedAt: '2026-08-21T00:00:00.000Z' }), false)
})
