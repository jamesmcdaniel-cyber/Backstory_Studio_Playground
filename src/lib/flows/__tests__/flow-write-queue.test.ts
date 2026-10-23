import test from 'node:test'
import assert from 'node:assert/strict'
import { queueFlowWrite } from '../flow-write-queue'

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('writes to one flow run one at a time, each built when its turn comes', async () => {
  let base = 'v0'
  const sent: string[] = []
  const write = (latency: number) => queueFlowWrite('f1', async () => {
    sent.push(base) // the request reads the base at send time
    await tick(latency)
    base = `v${sent.length}`
    return base
  })
  // An autosave and an explicit save fired together used to share a base.
  const [first, second] = await Promise.all([write(30), write(5)])
  assert.deepEqual(sent, ['v0', 'v1'], 'the second write carries the base the first returned')
  assert.deepEqual([first, second], ['v1', 'v2'])
})

test('a failed write does not block the next one, and still rejects for its caller', async () => {
  const failing = queueFlowWrite('f2', async () => { throw new Error('offline') })
  const next = queueFlowWrite('f2', async () => 'ok')
  await assert.rejects(failing, /offline/)
  assert.equal(await next, 'ok')
})

test('different flows do not wait on each other', async () => {
  const order: string[] = []
  const slow = queueFlowWrite('a', async () => { await tick(30); order.push('a') })
  const fast = queueFlowWrite('b', async () => { order.push('b') })
  await Promise.all([slow, fast])
  assert.deepEqual(order, ['b', 'a'])
})

test('a write that never settles does not freeze the writes queued behind it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { QUEUE_WAIT_MS } = await import('../flow-write-queue')
  void queueFlowWrite('hung', () => new Promise(() => {}))
  let ran = false
  const next = queueFlowWrite('hung', async () => { ran = true; return 'sent' })
  await Promise.resolve()
  assert.equal(ran, false, 'it waits for the write ahead of it first')
  t.mock.timers.tick(QUEUE_WAIT_MS)
  assert.equal(await next, 'sent')
  assert.equal(ran, true)
})
