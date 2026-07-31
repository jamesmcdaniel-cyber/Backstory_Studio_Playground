'use client'

import { resetSnapshotCache } from './snapshot'
import { resetCachedJson } from './use-cached-json'
import { FLOW_CLIPBOARD_KEY, FLOW_SELECTION_CLIPBOARD_KEY } from '@/lib/flows/clipboard'

/**
 * Bind the browser's client caches to one signed-in identity.
 *
 * The client caches (`bs:snapshot`, `bs:swr:<url>`, the flow clipboard and
 * picker favourites) hold authenticated workspace data and persist for up to a
 * day, keyed only by URL. Sign-out cleared the Supabase session and nothing
 * else, so the next person on the same browser — a shared machine, or the same
 * person switching accounts — got the previous user's agents, notifications,
 * org name and copied flow nodes painted from cache before revalidation.
 *
 * Rather than thread a user id through every cache key, we record who the cache
 * belongs to and wipe the whole set whenever that changes. One place to reason
 * about, and it fails safe: an unreadable/absent owner stamp wipes.
 *
 * Layout preferences (panel widths, sidebar collapsed, canvas zoom, builder
 * view) are deliberately NOT cleared — they describe the device, not the
 * account, and carry no workspace data.
 */

const OWNER_KEY = 'bs:cache-owner'

/** Keys holding workspace data that must not outlive the session that fetched it. */
const IDENTITY_SCOPED_KEYS = [
  FLOW_CLIPBOARD_KEY,
  FLOW_SELECTION_CLIPBOARD_KEY,
  'flows.pickerFavorites.v1',
]

/** Wipe every identity-scoped cache, in memory and in localStorage. */
export function clearClientCaches(): void {
  resetSnapshotCache()
  resetCachedJson()
  if (typeof window === 'undefined') return
  try {
    for (const key of IDENTITY_SCOPED_KEYS) window.localStorage.removeItem(key)
    window.localStorage.removeItem(OWNER_KEY)
  } catch {
    // Storage unavailable — the in-memory resets above still applied.
  }
}

/**
 * Reconcile the cache's owner with the currently signed-in user, clearing
 * everything when they differ. Pass null on sign-out.
 *
 * Returns true when a wipe happened, so callers can force a refetch rather than
 * render whatever a component already held in React state.
 */
export function syncCacheOwner(userId: string | null): boolean {
  if (typeof window === 'undefined') return false

  let owner: string | null = null
  try {
    owner = window.localStorage.getItem(OWNER_KEY)
  } catch {
    // Unreadable storage: treat as a mismatch and wipe. Failing safe here costs
    // one refetch; failing open shows the wrong workspace.
    clearClientCaches()
    return true
  }

  if (owner === userId) return false

  clearClientCaches()
  if (!userId) return true

  try {
    window.localStorage.setItem(OWNER_KEY, userId)
  } catch {
    // A cache we can't stamp is a cache we'll wipe again next time — correct,
    // just not optimal.
  }
  return true
}
