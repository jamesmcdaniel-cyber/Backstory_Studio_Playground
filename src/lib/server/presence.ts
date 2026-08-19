import { prisma } from '@/lib/prisma'

/**
 * Last-seen tracking.
 *
 * `User.lastSeenAt` shipped in the very first migration and was read by the
 * admin Users table from the day it existed — but nothing ever wrote it, so
 * every account read "Never" forever, including accounts signing in daily. This
 * is the writer.
 *
 * "Seen" means "made an authenticated request", which is the honest definition:
 * the app polls on every open page, so presence follows real use rather than
 * only sign-in events (a session that stays open for a week would otherwise
 * look like it went quiet on day one).
 *
 * Two throttles keep that from becoming a write per request:
 *
 *   1. An in-process cache, so a busy instance touches the database at most
 *      once per user per window. Serverless instances are ephemeral, so this is
 *      an optimization and never the guarantee.
 *   2. A staleness predicate in the UPDATE itself, so the guarantee holds
 *      across every instance at once: the row is written only when it is
 *      genuinely older than the window, and concurrent instances collapse into
 *      one effective write instead of racing.
 */

/** How stale the stored value must be before it is worth another write. */
export const PRESENCE_WINDOW_MS = 5 * 60 * 1000

/** userId → epoch ms we last wrote (or decided we did not need to). */
const recentlyRecorded = new Map<string, number>()

/**
 * Bound the cache so a long-lived instance in a large workspace cannot grow it
 * without limit. Well above any plausible concurrent-user count per instance,
 * so the eviction path is a backstop rather than routine.
 */
const MAX_TRACKED_USERS = 10_000

/**
 * Should this request bother touching the database?
 *
 * Pure apart from the module cache, and exported so the throttle is testable
 * without a database.
 */
export function shouldRecordPresence(userId: string, now: number, windowMs = PRESENCE_WINDOW_MS): boolean {
  const last = recentlyRecorded.get(userId)
  if (last !== undefined && now - last < windowMs) return false
  if (recentlyRecorded.size >= MAX_TRACKED_USERS) recentlyRecorded.clear()
  recentlyRecorded.set(userId, now)
  return true
}

/** Test seam — the cache is module state, which otherwise leaks between cases. */
export function resetPresenceCache(): void {
  recentlyRecorded.clear()
}

/**
 * Mark a user as seen now. Fire-and-forget by contract: presence is telemetry,
 * so it must never add latency to, or fail, the request that triggered it.
 */
export function recordPresence(userId: string, now: Date = new Date()): void {
  if (!shouldRecordPresence(userId, now.getTime())) return
  const cutoff = new Date(now.getTime() - PRESENCE_WINDOW_MS)
  // updateMany, not update: the staleness predicate belongs in the WHERE so the
  // database enforces the window across instances, and a missing row (deleted
  // mid-request) is a no-op rather than a thrown P2025.
  void prisma.user
    .updateMany({
      where: { id: userId, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }] },
      data: { lastSeenAt: now },
    })
    .catch(() => undefined)
}
