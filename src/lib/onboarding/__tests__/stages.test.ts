import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { onboardingStages, liveStageIndex, unlockedStage, shouldForwardToDashboard } from '@/lib/onboarding/stages'

afterEach(() => { delete process.env.APP_EDITION })

describe('internal edition onboarding', () => {
  test('has three stages ending in the live stage', () => {
    process.env.APP_EDITION = 'internal'
    assert.deepEqual(onboardingStages(), ['Connect your tools', 'Your data takes shape', 'Your AI goes live'])
    assert.equal(liveStageIndex(), 2)
  })

  test('the integration gate still governs how far you may go', () => {
    process.env.APP_EDITION = 'internal'
    assert.equal(unlockedStage({ entitlementDone: false, meetsGate: false }), 0)
    assert.equal(unlockedStage({ entitlementDone: true, meetsGate: false }), 1)
    assert.equal(unlockedStage({ entitlementDone: true, meetsGate: true }), 2)
  })

  test('forwarding still waits for the gate and an empty proposal inbox', () => {
    process.env.APP_EDITION = 'internal'
    assert.equal(shouldForwardToDashboard({ entitlementDone: true, meetsGate: true, openProposals: 0 }), true)
    assert.equal(shouldForwardToDashboard({ entitlementDone: true, meetsGate: true, openProposals: 2 }), false)
    assert.equal(shouldForwardToDashboard({ entitlementDone: true, meetsGate: true, openProposals: null }), false)
    assert.equal(shouldForwardToDashboard({ entitlementDone: false, meetsGate: true, openProposals: 0 }), false)
  })
})

describe('customer edition onboarding', () => {
  test('collapses to two stages', () => {
    process.env.APP_EDITION = 'customer'
    assert.deepEqual(onboardingStages(), ['Connect your tools', 'Your AI goes live'])
    assert.equal(liveStageIndex(), 1)
  })

  test('entitlement alone unlocks the live stage — no integration gate', () => {
    process.env.APP_EDITION = 'customer'
    assert.equal(unlockedStage({ entitlementDone: false, meetsGate: false }), 0)
    assert.equal(unlockedStage({ entitlementDone: true, meetsGate: false }), 1)
  })

  test('forwards on entitlement alone, so onboarding cannot hang', () => {
    process.env.APP_EDITION = 'customer'
    // openProposals stays null forever because nothing fetches it. This is the
    // regression guard for the hang.
    assert.equal(shouldForwardToDashboard({ entitlementDone: true, meetsGate: false, openProposals: null }), true)
    assert.equal(shouldForwardToDashboard({ entitlementDone: false, meetsGate: false, openProposals: null }), false)
  })
})
