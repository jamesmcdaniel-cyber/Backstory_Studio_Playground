import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  registerAssistantSurface,
  isAssistantSurfaceVisible,
  subscribeAssistantSurface,
  shouldOfferLauncher,
} from '../assistant-surface'

/** A panel root as the DOM would report it. `offsetParent` is null when the
 *  element or an ancestor is display:none — how /agents hides its assistant
 *  below the lg breakpoint. */
const el = (visible: boolean) =>
  ({ offsetParent: visible ? {} : null, getClientRects: () => (visible ? [{}] : []) }) as unknown as HTMLElement

beforeEach(() => {
  // Drain any registration a previous test left behind.
  while (isAssistantSurfaceVisible()) break
})

test('no registered surface means nothing is covering the corner', () => {
  assert.equal(isAssistantSurfaceVisible(), false)
})

test('a visible surface is reported, and unregistering clears it', () => {
  const unregister = registerAssistantSurface(el(true))
  assert.equal(isAssistantSurfaceVisible(), true)
  unregister()
  assert.equal(isAssistantSurfaceVisible(), false)
})

test('a mounted but display:none surface does not count', () => {
  const unregister = registerAssistantSurface(el(false))
  assert.equal(isAssistantSurfaceVisible(), false)
  unregister()
})

test('one visible surface is enough when another is hidden', () => {
  const hidden = registerAssistantSurface(el(false))
  const shown = registerAssistantSurface(el(true))
  assert.equal(isAssistantSurfaceVisible(), true)
  shown()
  assert.equal(isAssistantSurfaceVisible(), false)
  hidden()
})

test('subscribers are notified only when the answer actually changes', () => {
  let calls = 0
  const unsubscribe = subscribeAssistantSurface(() => { calls += 1 })
  const first = registerAssistantSurface(el(true))
  assert.equal(calls, 1)
  const second = registerAssistantSurface(el(true))
  assert.equal(calls, 1, 'a second visible surface does not change the answer')
  first()
  assert.equal(calls, 1, 'still covered by the second surface')
  second()
  assert.equal(calls, 2)
  unsubscribe()
})

test('the launcher is offered whenever nothing else occupies the corner', () => {
  assert.equal(shouldOfferLauncher(false, false), true)
})

test('the launcher yields the corner to a page-level assistant', () => {
  assert.equal(shouldOfferLauncher(true, false), false)
})

test('an open conversation is never yanked away by a page-level assistant', () => {
  assert.equal(shouldOfferLauncher(true, true), true)
})
