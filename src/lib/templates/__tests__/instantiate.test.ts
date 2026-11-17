import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scheduleFromCadence, unreachableIntegrations } from '../instantiate'

test('scheduleFromCadence: a periodic cadence becomes an ACTIVE schedule', () => {
  assert.deepEqual(scheduleFromCadence('weekly'), { type: 'weekly', timezone: 'UTC', isActive: true })
  assert.deepEqual(scheduleFromCadence('daily'), { type: 'daily', timezone: 'UTC', isActive: true })
  assert.deepEqual(scheduleFromCadence('cron'), { type: 'cron', timezone: 'UTC', isActive: true })
})

test('scheduleFromCadence: manual/empty/unknown becomes an inactive manual schedule', () => {
  assert.deepEqual(scheduleFromCadence('manual'), { type: 'manual', timezone: 'UTC', isActive: false })
  assert.deepEqual(scheduleFromCadence(''), { type: 'manual', timezone: 'UTC', isActive: false })
  assert.deepEqual(scheduleFromCadence(undefined), { type: 'manual', timezone: 'UTC', isActive: false })
  assert.deepEqual(scheduleFromCadence('nonsense'), { type: 'manual', timezone: 'UTC', isActive: false })
})

test('unreachableIntegrations: a reachable integration is never a setup item, whatever spelling the template uses', () => {
  const reachable = new Set(['backstory', 'gmail', 'slack'])
  // The agent path stores tool-plane ids; the connected key has no prefix.
  assert.deepEqual(unreachableIntegrations(['Backstory', 'nango:gmail', 'native:slack'], reachable), [])
  assert.deepEqual(unreachableIntegrations(['backstory', 'salesforce'], reachable), ['salesforce'])
})

test('unreachableIntegrations: connection-free built-ins never ask to be connected', () => {
  assert.deepEqual(unreachableIntegrations(['ROI', 'Repository', 'Code', 'native:http api'], new Set()), [])
})
