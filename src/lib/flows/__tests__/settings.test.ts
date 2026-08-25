import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_FLOW_SETTINGS, flowSettingsSchema, parseFlowSettings, subflowCallerAllowed } from '../settings'

test('legacy flows receive safe, backward-compatible settings defaults', () => {
  assert.deepEqual(parseFlowSettings(null), DEFAULT_FLOW_SETTINGS)
  assert.equal(DEFAULT_FLOW_SETTINGS.availableInMcp, true)
  assert.equal(DEFAULT_FLOW_SETTINGS.executionOrder, 'v2')
})

test('settings reject invalid timezones and unbounded execution policy', () => {
  assert.equal(flowSettingsSchema.safeParse({ timezone: 'Mars/Olympus' }).success, false)
  assert.equal(flowSettingsSchema.safeParse({ timeoutSeconds: 100_000 }).success, false)
})

test('subflow caller policy supports none, same-owner, and explicit allowlists', () => {
  const caller = { flowId: 'parent', ownerId: 'user-1' }
  assert.equal(subflowCallerAllowed(parseFlowSettings({ callerPolicy: 'none' }), caller, { ownerId: 'user-1' }), false)
  assert.equal(subflowCallerAllowed(parseFlowSettings({ callerPolicy: 'sameOwner' }), caller, { ownerId: 'user-1' }), true)
  assert.equal(subflowCallerAllowed(parseFlowSettings({ callerPolicy: 'sameOwner' }), caller, { ownerId: 'user-2' }), false)
  assert.equal(subflowCallerAllowed(parseFlowSettings({ callerPolicy: 'allowlist', allowedCallerFlowIds: ['parent'] }), caller, { ownerId: null }), true)
})
