import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { keepDetachedWorkAlive } from '@/lib/flows/keep-alive'

/**
 * The regression this guards: a flow run dispatched as a floating promise is
 * killed when the serverless invocation freezes at response time, so the run
 * row exists but no step ever runs and nothing is logged.
 */
describe('keepDetachedWorkAlive', () => {
  it('registers the work so the host holds the invocation open', () => {
    const work = Promise.resolve('done')
    const registered: unknown[] = []
    keepDetachedWorkAlive(work, (w) => registered.push(w))
    assert.deepEqual(registered, [work], 'the run promise must be handed to the host, not left floating')
  })

  it('swallows the throw outside a request scope, where the caller outlives the work', () => {
    assert.doesNotThrow(() =>
      keepDetachedWorkAlive(Promise.resolve(), () => {
        throw new Error('after() was called outside a request scope')
      }),
    )
  })

  it('never swallows the work itself — a rejection still settles on the caller\'s handler', async () => {
    let seen: unknown
    const work = Promise.reject(new Error('boom')).catch((error) => {
      seen = error
    })
    keepDetachedWorkAlive(work, () => {})
    await work
    assert.equal((seen as Error).message, 'boom')
  })
})
