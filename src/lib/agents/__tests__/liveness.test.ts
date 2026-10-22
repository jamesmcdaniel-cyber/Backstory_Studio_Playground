import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { startExecutionHeartbeat } from '../liveness'

/**
 * The heartbeat is the reaper's only evidence that a run is alive, so the
 * timer must start with the run's row, keep going for as long as the run does,
 * and stop the moment it settles.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function recorder(fail = false) {
  const beats: { executionId: string; organizationId: string }[] = []
  return {
    beats,
    deps: {
      intervalMs: 10,
      touch: async (executionId: string, organizationId: string) => {
        beats.push({ executionId, organizationId })
        if (fail) throw new Error('db down')
      },
    },
  }
}

describe('startExecutionHeartbeat', () => {
  test('nothing beats until the execution row exists', async () => {
    const { beats, deps } = recorder()
    const heartbeat = startExecutionHeartbeat('org-1', deps)
    await wait(30)
    heartbeat.stop()
    assert.equal(beats.length, 0)
  })

  test('beats at once on track, then on every interval, for the run’s own tenant', async () => {
    const { beats, deps } = recorder()
    const heartbeat = startExecutionHeartbeat('org-1', deps)
    heartbeat.track('exec-1')
    assert.equal(beats.length, 1, 'the first beat is immediate')
    await wait(45)
    heartbeat.stop()
    assert.ok(beats.length >= 3)
    assert.ok(beats.every((beat) => beat.executionId === 'exec-1' && beat.organizationId === 'org-1'))
  })

  test('stop ends the beats', async () => {
    const { beats, deps } = recorder()
    const heartbeat = startExecutionHeartbeat('org-1', deps)
    heartbeat.track('exec-1')
    heartbeat.stop()
    const count = beats.length
    await wait(40)
    assert.equal(beats.length, count)
  })

  test('a failed write never throws into the run', async () => {
    const { beats, deps } = recorder(true)
    const heartbeat = startExecutionHeartbeat('org-1', deps)
    assert.doesNotThrow(() => heartbeat.track('exec-1'))
    await wait(25)
    heartbeat.stop()
    assert.ok(beats.length >= 2, 'keeps trying after a failure')
  })
})
