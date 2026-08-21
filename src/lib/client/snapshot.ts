'use client'

import type { Activity, Agent } from '@/lib/types'

/**
 * Client accessor for GET /api/snapshot — the ONE poll the app shell makes.
 *
 * The dashboard (10s), sidebar (30s), and notification bell (15s) all call
 * getSnapshot() on their own cadences; a freshness window (default 8s) +
 * in-flight dedupe collapse those into ~one network request per cycle for the
 * whole shell instead of six. localStorage persistence gives an instant paint
 * after a reload, then the background refresh replaces it.
 */

export type Snapshot = {
  success: boolean
  agents: Agent[]
  workspaceFolders?: Array<{ id: string; name: string }>
  activities: Activity[]
  usage: { since: string; executions: number; usedTokens: number; budgetTokens: number; exempt?: boolean }
  activeOrganizationId: string | null
  organizations: Array<{ id: string; name: string; slug: string; plan: string; logoUrl?: string | null }>
  notifications: Array<Record<string, unknown>>
  unread: number
}

export class SnapshotError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message)
    this.name = 'SnapshotError'
  }
}

const LS_KEY = 'bs:snapshot'
const MAX_PERSIST_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_FRESH_MS = 8_000

let cached: { data: Snapshot; ts: number } | null = null
let inflight: Promise<Snapshot> | null = null

// Bumped on every reset. A fetch that STARTED before a reset can resolve
// after it carrying pre-reset data; comparing the epoch it captured keeps
// that response from re-poisoning the cache it was evicted from. Its own
// awaiters still get their data — it just never becomes the shared copy.
let epoch = 0

function readPersisted(): { data: Snapshot; ts: number } | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(LS_KEY)
    if (!raw) return null
    const entry = JSON.parse(raw) as { data: Snapshot; ts: number }
    if (!entry?.data || typeof entry.ts !== 'number' || Date.now() - entry.ts > MAX_PERSIST_AGE_MS) return null
    return entry
  } catch {
    return null
  }
}

function persist(entry: { data: Snapshot; ts: number }) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(entry))
  } catch {
    // quota errors are non-fatal; the in-memory cache still applies
  }
}

async function fetchSnapshot(): Promise<Snapshot> {
  const startedIn = epoch
  const res = await fetch('/api/snapshot', { cache: 'no-store' })
  const body = (await res.json().catch(() => ({}))) as Partial<Snapshot> & { error?: string; code?: string }
  if (!res.ok) throw new SnapshotError(body.error || `Snapshot failed (${res.status})`, body.code, res.status)
  const entry = { data: body as Snapshot, ts: Date.now() }
  if (startedIn === epoch) {
    cached = entry
    persist(entry)
  }
  return entry.data
}

/**
 * Return the snapshot, hitting the network only when the cached copy is older
 * than `maxAgeMs` (0 forces a fetch, e.g. after a mutation). Concurrent
 * callers share one request.
 */
export async function getSnapshot(maxAgeMs: number = DEFAULT_FRESH_MS): Promise<Snapshot> {
  cached ??= readPersisted()
  if (cached && Date.now() - cached.ts < maxAgeMs) return cached.data
  inflight ??= fetchSnapshot().finally(() => { inflight = null })
  return inflight
}

/** Last-seen snapshot (memory → localStorage), for instant first paint. */
export function peekSnapshot(): Snapshot | null {
  cached ??= readPersisted()
  return cached?.data ?? null
}

/**
 * Drop the snapshot from memory AND localStorage. Called when the signed-in
 * identity changes (sign-out, account switch) — this cache holds a workspace's
 * agents, notifications and usage, so leaving it behind paints the previous
 * user's data to the next one on the same browser. See client/cache-owner.ts.
 */
export function resetSnapshotCache(): void {
  epoch += 1
  cached = null
  inflight = null
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(LS_KEY)
  } catch {
    // Storage unavailable (private mode / quota) — the memory reset above still applies.
  }
}
