import test from 'node:test'
import assert from 'node:assert/strict'
import { runIsStoppable } from '../run-panel'
import { groupLabels, groupOrder } from '@/app/agents/agent-activity-pane'

// POST /api/flows/[id]/cancel had no client caller: a flow run, once started,
// could not be stopped from the builder.
test('Stop is offered for running and paused runs only', () => {
  assert.equal(runIsStoppable('running'), true)
  assert.equal(runIsStoppable('waiting'), true)
  for (const status of ['cancelling', 'cancelled', 'succeeded', 'failed', undefined]) {
    assert.equal(runIsStoppable(status), false, String(status))
  }
})

// A queued agent run had no group, so its row never rendered — while the
// agents page disabled Run with "watch or stop it below".
test('the agent activity pane has a Queued group for pending runs', () => {
  assert.ok((groupOrder as readonly string[]).includes('pending'))
  assert.equal(groupLabels.pending, 'Queued')
})
