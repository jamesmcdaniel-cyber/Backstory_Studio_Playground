'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Stale-while-revalidate JSON fetch with a client cache that survives both
 * navigations AND full reloads.
 *
 * The app fetches with raw `fetch` + `useState`, so every component starts empty
 * and refetches on mount — and because each page renders its own layout,
 * navigating remounts everything, showing a loading state until the refetch
 * lands. This hook caches responses by URL in two tiers:
 *   - an in-memory Map for instant paint on client-side navigation (same tab
 *     session), and
 *   - localStorage so a revisit or reload paints the LAST-SEEN data immediately
 *     ("already loads the cached page") instead of a spinner.
 * Either way it revalidates in the background, and concurrent callers for the
 * same URL share one request.
 *
 * SSR-safe: the memory map is only ever written on the client (in refresh),
 * so server renders read an empty cache — no cross-user leakage and no
 * hydration mismatch (localStorage is read in an effect, after mount).
 * Endpoints stay `no-store` on the wire; this is a client-memory/localStorage
 * cache only, never persisted-stale beyond MAX_AGE and always revalidated.
 */

type Entry = { data: unknown; ts: number }
const mem = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()
const LS_PREFIX = 'bs:swr:'
const MAX_AGE_MS = 24 * 60 * 60 * 1000 // don't paint anything older than a day

function readPersisted(url: string): Entry | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem(LS_PREFIX + url)
    if (!raw) return undefined
    const entry = JSON.parse(raw) as Entry
    if (!entry || typeof entry.ts !== 'number' || Date.now() - entry.ts > MAX_AGE_MS) return undefined
    return entry
  } catch {
    return undefined
  }
}

function write(url: string, data: unknown): void {
  const entry: Entry = { data, ts: Date.now() }
  mem.set(url, entry)
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(LS_PREFIX + url, JSON.stringify(entry))
  } catch {
    // Quota/serialization failures are non-fatal — memory cache still applies.
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string })?.error || `Request failed (${res.status})`)
  return body
}

export function useCachedJson<T = unknown>(url: string | null) {
  // Lazy init reads only the in-memory cache (empty on the server → SSR-safe).
  const [data, setData] = useState<T | undefined>(() => (url ? (mem.get(url)?.data as T | undefined) : undefined))
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(() => (url ? !mem.has(url) : false))

  const refresh = useCallback(async () => {
    if (!url) return
    let pending = inflight.get(url)
    if (!pending) {
      pending = fetchJson(url)
      inflight.set(url, pending)
    }
    try {
      const result = await pending
      write(url, result)
      setData(result as T)
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      inflight.delete(url)
      setLoading(false)
    }
  }, [url])

  useEffect(() => {
    if (!url) return
    // Hydrate from the persisted cache (localStorage) if memory missed — makes a
    // reload/revisit paint the last-seen data instead of a spinner.
    if (!mem.has(url)) {
      const persisted = readPersisted(url)
      if (persisted) {
        mem.set(url, persisted)
        setData(persisted.data as T)
        setLoading(false)
      }
    }
    void refresh()
  }, [url, refresh])

  // Optimistically overwrite the cached value (e.g. after a local mutation).
  const mutate = useCallback(
    (next: T) => {
      if (url) write(url, next)
      setData(next)
    },
    [url],
  )

  return { data, loading, error, refresh, mutate }
}

/**
 * Drop EVERY cached response — memory, in-flight map, and all persisted
 * `bs:swr:` keys. Called when the signed-in identity changes: these entries are
 * authenticated API responses keyed only by URL, so without this the next user
 * on the same browser paints the previous user's workspace. See
 * client/cache-owner.ts.
 */
export function resetCachedJson(): void {
  mem.clear()
  inflight.clear()
  if (typeof window === 'undefined') return
  try {
    const stale = Object.keys(window.localStorage).filter((key) => key.startsWith(LS_PREFIX))
    for (const key of stale) window.localStorage.removeItem(key)
  } catch {
    // Storage unavailable — the memory reset above still applies.
  }
}

/** Drop a URL's cached entry so the next mount/refresh refetches from the server. */
export function invalidateCachedJson(url: string): void {
  mem.delete(url)
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(LS_PREFIX + url)
  } catch {
    // ignore
  }
}
