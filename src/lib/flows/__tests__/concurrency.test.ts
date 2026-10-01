import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireFlowSlot, shouldGuardFlowWrite } from '../concurrency'

test('execution slots serialize one flow, isolate tenants, and release safely', async () => {
  const release = await acquireFlowSlot('org-qa', 'flow-qa', 1)
  assert.ok(release)
  assert.equal(await acquireFlowSlot('org-qa', 'flow-qa', 1), null)
  const other = await acquireFlowSlot('other-org', 'flow-qa', 1)
  assert.ok(other)
  await release()
  const next = await acquireFlowSlot('org-qa', 'flow-qa', 1)
  assert.ok(next)
  await next()
  await other()
})

test('full-graph writes use the optimistic concurrency guard', () => {
  assert.equal(shouldGuardFlowWrite({ graph: { nodes: [], edges: [] }, baseUpdatedAt: '2026-08-21T00:00:00.000Z' }), true)
})

test('settings-only writes do not race a pending graph autosave', () => {
  assert.equal(shouldGuardFlowWrite({ graph: undefined, baseUpdatedAt: '2026-08-21T00:00:00.000Z' }), false)
})
