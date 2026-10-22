import { test } from 'node:test'
import assert from 'node:assert/strict'
import { workerConfig } from '../config'
import { AGENT_STALE_AFTER_MS } from '@/lib/agents/reap'
import { DATASET_TIMEOUT_MAX_MS } from '@/features/flows/code-runner'

/**
 * Three clocks that must stay in order, each set in a different file.
 *
 * A dead worker's job is recovered by BullMQ once its lock lapses and the next
 * stalled scan runs; the agent reaper fails the run once its heartbeat has been
 * stale long enough. Recovery has to come first, or the reaper fails a run
 * that was about to resume from its checkpoint. And the lock has to outlast the
 * longest deliberate event-loop block, or a LIVE job is declared stalled and
 * run twice.
 */

test('stall recovery of a dead worker’s job lands before the agent reaper fails it', () => {
  assert.ok(workerConfig.lockDuration + workerConfig.stalledInterval < AGENT_STALE_AFTER_MS)
})

test('a Pyodide step blocking the event loop cannot cost a live job its lock', () => {
  // Renewal fires every lockDuration/4 (lockRenewTime defaults to half the
  // lock, and the renewal timer to half of that), so a block loses the lock
  // once it outlasts the remaining 3/4.
  assert.ok(DATASET_TIMEOUT_MAX_MS < (workerConfig.lockDuration * 3) / 4)
})
