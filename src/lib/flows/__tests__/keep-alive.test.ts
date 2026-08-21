import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { keepDetachedWorkAlive, trackDetached } from '@/lib/flows/keep-alive'

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

/**
 * The regression this guards: every `void someBestEffortCall(...)` side
 * channel in the engine (ledger writes, token-usage rollups, shadow sampling,
 * PII egress recording, run-tick broadcasts) left its promise floating —
 * un-registered with keepDetachedWorkAlive — so serverless teardown could
 * drop any of them, not just the top-level run promise.
 */
describe('trackDetached', () => {
  it('registers a real promise with the host', () => {
    const work = Promise.resolve('done')
    const registered: unknown[] = []
    trackDetached(work, (w) => registered.push(w))
    assert.equal(registered.length, 1, 'the side-channel promise must be handed to the host, not left floating')
  })

  it('no-ops for undefined — a broadcaster that skipped the call (unconfigured) has nothing to track', () => {
    const registered: unknown[] = []
    trackDetached(undefined, (w) => registered.push(w))
    trackDetached(null, (w) => registered.push(w))
    assert.deepEqual(registered, [])
  })

  it('swallows the tracked promise rejecting — a ledger/egress/broadcast failure must never surface as an unhandled rejection', async () => {
    let registeredWork: Promise<unknown> | undefined
    trackDetached(Promise.reject(new Error('boom')), (w) => {
      registeredWork = w
    })
    await assert.doesNotReject(registeredWork!)
  })
})
