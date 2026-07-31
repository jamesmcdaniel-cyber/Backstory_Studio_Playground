import '@/test-support/jsdom-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startVisibleInterval } from '../visible-interval'

/**
 * The behaviour that matters: a backgrounded tab issues no requests, and coming
 * back does not make the user wait out the remaining delay to see fresh state.
 */

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { value: hidden, configurable: true })
  document.dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event('visibilitychange'))
}

beforeEach(() => {
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
})

test('ticks while visible', async () => {
  let ticks = 0
  const stop = startVisibleInterval(() => { ticks += 1 }, 10)
  await new Promise((resolve) => setTimeout(resolve, 45))
  stop()
  assert.ok(ticks >= 2, `expected repeated ticks while visible, got ${ticks}`)
})

test('stops ticking while the tab is hidden', async () => {
  let ticks = 0
  const stop = startVisibleInterval(() => { ticks += 1 }, 10)

  Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  const before = ticks
  await new Promise((resolve) => setTimeout(resolve, 45))
  stop()

  assert.equal(ticks, before, 'a hidden tab must issue nothing at all')
})

test('becoming visible again ticks immediately rather than waiting out the delay', async () => {
  let ticks = 0
  // A long delay: any tick inside the test window can only have come from the
  // visibility handler, not the interval.
  const stop = startVisibleInterval(() => { ticks += 1 }, 60_000)

  setHidden(true)
  const hiddenTicks = ticks
  setHidden(false)
  stop()

  assert.equal(ticks, hiddenTicks + 1, 'returning to the tab refreshes at once')
})

test('stop() removes the interval and the listener', async () => {
  let ticks = 0
  const stop = startVisibleInterval(() => { ticks += 1 }, 10)
  stop()

  const after = ticks
  setHidden(false) // would tick if the listener were still attached
  await new Promise((resolve) => setTimeout(resolve, 45))

  assert.equal(ticks, after, 'nothing fires after teardown')
})
