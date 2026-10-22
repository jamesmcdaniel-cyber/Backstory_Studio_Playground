import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { streamDeadline } from '../stream-deadline'

/**
 * The SDK timeout ends once response headers arrive, so before this a stream
 * that stalled mid-body hung its caller indefinitely. The deadline must abort
 * the call, say which bound tripped, and leave no timer behind.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A stand-in for an SDK stream: settles when told to, rejects when its signal aborts. */
function fakeCall(signal: AbortSignal) {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((res, reject) => {
    resolve = res
    signal.addEventListener('abort', () => reject(new Error('Request was aborted.')))
  })
  return { promise, resolve }
}

describe('streamDeadline', () => {
  test('a stream that goes quiet is aborted by the idle bound, with a message that says so', async () => {
    const deadline = streamDeadline({ totalMs: 1_000, idleMs: 20, label: 'The model call' })
    const call = fakeCall(deadline.signal)
    await assert.rejects(deadline.guard(call.promise), /The model call stalled: nothing streamed/)
    deadline.clear()
  })

  test('activity keeps a slow stream alive until the overall deadline', async () => {
    const deadline = streamDeadline({ totalMs: 80, idleMs: 30, label: 'The model call' })
    const call = fakeCall(deadline.signal)
    const ticker = setInterval(() => deadline.touch(), 10)
    try {
      await assert.rejects(deadline.guard(call.promise), /exceeded its .* deadline/)
    } finally {
      clearInterval(ticker)
      deadline.clear()
    }
  })

  test('a call that finishes in time returns its result, and clear stops both timers', async () => {
    const deadline = streamDeadline({ totalMs: 30, idleMs: 20, label: 'The model call' })
    const call = fakeCall(deadline.signal)
    call.resolve('done')
    assert.equal(await deadline.guard(call.promise), 'done')
    deadline.clear()
    await wait(50)
    assert.equal(deadline.signal.aborted, false)
  })

  test('an error that is not ours passes through untouched', async () => {
    const deadline = streamDeadline({ totalMs: 1_000, idleMs: 1_000, label: 'The model call' })
    const failure = Object.assign(new Error('529 overloaded'), { status: 529 })
    await assert.rejects(deadline.guard(Promise.reject(failure)), (error) => error === failure)
    deadline.clear()
  })
})
