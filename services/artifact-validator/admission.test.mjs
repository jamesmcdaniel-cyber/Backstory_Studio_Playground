import test from 'node:test'
import assert from 'node:assert/strict'
import { admission } from './admission.mjs'

test('bounded FIFO admits concurrent requests without polling or exceeding capacity', async () => {
  const gate = admission({ limit: 2 })
  const first = await gate.acquire()
  const order = []
  const second = gate.acquire().then(release => { order.push(2); return release })
  const third = gate.acquire().then(release => { order.push(3); return release })
  await assert.rejects(gate.acquire(), /queue full/)
  assert.equal(gate.stats().active, 1)
  first(); (await second)(); (await third)()
  assert.deepEqual(order, [2, 3])
  assert.equal(gate.stats().active, 0)
})

test('cancellation and deadlines remove waiters without leaking capacity', async () => {
  const gate = admission({ timeoutMs: 10 })
  const release = await gate.acquire()
  const controller = new AbortController()
  const cancelled = gate.acquire(controller.signal)
  controller.abort()
  await assert.rejects(cancelled, /cancelled/)
  await assert.rejects(gate.acquire(), /deadline/)
  assert.equal(gate.stats().queued, 0)
  release()
  ;(await gate.acquire())()
})
