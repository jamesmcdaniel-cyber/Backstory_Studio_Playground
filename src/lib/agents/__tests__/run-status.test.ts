import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentHasLiveRun, liveAgentIds } from '../run-status'

const activity = (agentTaskId: string | null, status: string) => ({ agentTaskId, status })

test('running, pending and cancelling runs count as live', () => {
  for (const status of ['running', 'pending', 'cancelling']) {
    assert.equal(agentHasLiveRun([activity('a1', status)], 'a1'), true, status)
  }
})

test('a run waiting on a person is still live — the agent has not finished', () => {
  for (const status of ['waiting', 'waiting_for_approval', 'waiting_for_input']) {
    assert.equal(agentHasLiveRun([activity('a1', status)], 'a1'), true, status)
  }
})

test('terminal runs are not live', () => {
  for (const status of ['completed', 'failed', 'blocked', 'cancelled']) {
    assert.equal(agentHasLiveRun([activity('a1', status)], 'a1'), false, status)
  }
})

test('only the asked-about agent counts', () => {
  assert.equal(agentHasLiveRun([activity('other', 'running')], 'a1'), false)
  assert.equal(agentHasLiveRun([activity(null, 'running')], 'a1'), false)
})

test('liveAgentIds collects every agent with a live run, once', () => {
  const ids = liveAgentIds([
    activity('a1', 'running'),
    activity('a1', 'waiting_for_input'),
    activity('a2', 'completed'),
    activity('a3', 'pending'),
    activity(null, 'running'),
  ])
  assert.deepEqual([...ids].sort(), ['a1', 'a3'])
})
