import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveFlowOperationalStatus } from '@/lib/flows/operational-status'

describe('deriveFlowOperationalStatus', () => {
  test('is idle without an active run', () => {
    assert.equal(deriveFlowOperationalStatus([]), 'idle')
  })

  test('is queued until the execution backend starts a step', () => {
    assert.equal(deriveFlowOperationalStatus([{ status: 'running', stepCount: 0 }]), 'queued')
  })

  test('is running once a step exists or cancellation is in progress', () => {
    assert.equal(deriveFlowOperationalStatus([{ status: 'running', stepCount: 1 }]), 'running')
    assert.equal(deriveFlowOperationalStatus([{ status: 'cancelling', stepCount: 0 }]), 'running')
  })

  test('blocked takes priority when any concurrent run is waiting', () => {
    assert.equal(
      deriveFlowOperationalStatus([
        { status: 'running', stepCount: 2 },
        { status: 'waiting', stepCount: 3 },
      ]),
      'blocked',
    )
  })
})
