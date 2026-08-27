import test from 'node:test'
import assert from 'node:assert/strict'
import { isTerminalFlowRunStatus, waitForFlowRunResult } from '../webhook-result'

test('webhook response wait returns a fast terminal result', async () => {
  const states = [{ status: 'running' }, { status: 'succeeded', output: { ok: true } }]
  let clock = 0
  const result = await waitForFlowRunResult({
    load: async () => states.shift() ?? null,
    timeoutMs: 1_000,
    pollMs: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  })
  assert.deepEqual(result, { status: 'succeeded', output: { ok: true } })
})

test('webhook response wait is bounded and leaves a running execution alone', async () => {
  let clock = 0
  let reads = 0
  const result = await waitForFlowRunResult({
    load: async () => { reads += 1; return { status: 'running' } },
    timeoutMs: 250,
    pollMs: 100,
    now: () => clock,
    sleep: async (ms) => { clock += ms },
  })
  assert.deepEqual(result, { status: 'running' })
  assert.ok(reads >= 2)
  assert.ok(clock <= 250)
})

test('a paused flow releases the response immediately', async () => {
  let sleeps = 0
  const result = await waitForFlowRunResult({
    load: async () => ({ status: 'waiting' }),
    timeoutMs: 5_000,
    sleep: async () => { sleeps += 1 },
  })
  assert.equal(result?.status, 'waiting')
  assert.equal(sleeps, 0)
  assert.equal(isTerminalFlowRunStatus('waiting'), false)
  assert.equal(isTerminalFlowRunStatus('failed'), true)
})
