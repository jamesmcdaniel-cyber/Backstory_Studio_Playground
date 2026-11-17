import { test } from 'node:test'
import assert from 'node:assert/strict'
import { disarmAgentSchedules, disarmFlowTrigger } from '../snapshot'

/**
 * A demo clone must not fire on its own. Each sandbox used to copy the real
 * workspace's armed schedules under active shadow members, so every sandbox
 * re-ran the source org's scheduled fleet with real model spend.
 */

test('an agent clone keeps its cadence but switched off — draft and published both', () => {
  const agent = disarmAgentSchedules({
    id: 'a1',
    schedule: { type: 'daily', time: '09:00', isActive: true },
    publishedConfig: { objective: 'x', description: 'y', schedule: { type: 'hourly', isActive: true } },
  })
  assert.deepEqual(agent.schedule, { type: 'daily', time: '09:00', isActive: false })
  assert.deepEqual((agent.publishedConfig as { schedule: unknown }).schedule, { type: 'hourly', isActive: false })
  assert.equal(agent.id, 'a1')
})

test('an unpublished agent stays unpublished', () => {
  const agent = disarmAgentSchedules({ schedule: { type: 'manual', isActive: false }, publishedConfig: null })
  assert.equal(agent.publishedConfig, null)
})

test('scheduled and polling flow triggers are switched off; other triggers are untouched', () => {
  const scheduled = disarmFlowTrigger({ trigger: { type: 'schedule', schedule: { type: 'cron', cron: '*/15 * * * *', isActive: true }, input: 'go' } })
  assert.deepEqual(scheduled.trigger, { type: 'schedule', schedule: { type: 'cron', cron: '*/15 * * * *', isActive: false }, input: 'go' })

  const poll = disarmFlowTrigger({ trigger: { type: 'poll', schedule: { type: 'hourly', isActive: true } } })
  assert.equal((poll.trigger as { schedule: { isActive: boolean } }).schedule.isActive, false)

  const webhook = { trigger: { type: 'webhook' } }
  assert.equal(disarmFlowTrigger(webhook), webhook)
})
