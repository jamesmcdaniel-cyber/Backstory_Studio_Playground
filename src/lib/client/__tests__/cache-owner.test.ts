import '@/test-support/jsdom-env'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { clearClientCaches, syncCacheOwner } from '../cache-owner'
import { peekSnapshot } from '../snapshot'

/**
 * The invariant: workspace data cached in the browser never outlives the
 * identity that fetched it. A shared machine, or one person switching accounts,
 * must not paint the previous user's org.
 */

const SNAPSHOT_KEY = 'bs:snapshot'
const SWR_KEY = 'bs:swr:/api/flows'
const OWNER_KEY = 'bs:cache-owner'
const CLIPBOARD_KEY = 'flows.clipboard.v2'
const LAYOUT_KEY = 'flow.copilotWidth'

function seedCaches() {
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ data: { agents: [{ id: 'secret' }] }, ts: Date.now() }))
  localStorage.setItem(SWR_KEY, JSON.stringify({ data: [{ id: 'flow-a' }], ts: Date.now() }))
  localStorage.setItem(CLIPBOARD_KEY, JSON.stringify({ nodes: [{ id: 'copied' }] }))
  localStorage.setItem(LAYOUT_KEY, '420')
}

beforeEach(() => {
  localStorage.clear()
  clearClientCaches()
  localStorage.clear()
})

test('signing out wipes cached workspace data', () => {
  syncCacheOwner('user-a')
  seedCaches()

  const wiped = syncCacheOwner(null)

  assert.equal(wiped, true)
  assert.equal(localStorage.getItem(SNAPSHOT_KEY), null)
  assert.equal(localStorage.getItem(SWR_KEY), null)
  assert.equal(localStorage.getItem(CLIPBOARD_KEY), null)
  assert.equal(localStorage.getItem(OWNER_KEY), null)
})

test('switching accounts on the same browser wipes the previous user’s cache', () => {
  syncCacheOwner('user-a')
  seedCaches()

  const wiped = syncCacheOwner('user-b')

  assert.equal(wiped, true)
  assert.equal(localStorage.getItem(SNAPSHOT_KEY), null)
  assert.equal(localStorage.getItem(SWR_KEY), null)
  assert.equal(localStorage.getItem(OWNER_KEY), 'user-b', 'the cache is re-stamped for the new owner')
})

test('the same user reloading keeps their cache', () => {
  syncCacheOwner('user-a')
  seedCaches()

  const wiped = syncCacheOwner('user-a')

  assert.equal(wiped, false)
  assert.notEqual(localStorage.getItem(SNAPSHOT_KEY), null, 'a same-owner reload must still paint instantly')
  assert.notEqual(localStorage.getItem(SWR_KEY), null)
})

test('an unclaimed cache is wiped before the first user claims it', () => {
  // Data present with no owner stamp: the state a browser is in after this
  // change ships to a session that cached under the old, unstamped scheme.
  seedCaches()

  const wiped = syncCacheOwner('user-a')

  assert.equal(wiped, true)
  assert.equal(localStorage.getItem(SNAPSHOT_KEY), null)
  assert.equal(localStorage.getItem(OWNER_KEY), 'user-a')
})

test('device layout preferences survive a wipe', () => {
  syncCacheOwner('user-a')
  seedCaches()

  syncCacheOwner('user-b')

  assert.equal(localStorage.getItem(LAYOUT_KEY), '420', 'panel widths describe the device, not the account')
})

test('the in-memory snapshot is dropped too, not just localStorage', () => {
  syncCacheOwner('user-a')
  localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ data: { agents: [{ id: 'secret' }] }, ts: Date.now() }))
  // Pull it into the module-level memory cache the way a render would.
  assert.notEqual(peekSnapshot(), null)

  syncCacheOwner('user-b')

  assert.equal(peekSnapshot(), null, 'a wipe that leaves the memory cache is no wipe at all')
})
