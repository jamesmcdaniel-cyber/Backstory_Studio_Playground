/**
 * Read-through cache with a Redis backend and an in-memory fallback.
 *
 * Redis-backed when REDIS_URL is set (shared across processes/instances — the
 * real cache in production); otherwise a bounded per-process in-memory map
 * (local dev, or when Redis is unreachable). Backend selection mirrors the
 * ratelimit.ts seam.
 *
 * Every operation is BEST-EFFORT: a cache miss, corrupt value, or backend
 * outage never breaks the caller — it falls through to the source of truth.
 * Negatives (null/undefined) are never cached, so a transient upstream failure
 * can't get pinned for the TTL.
 */

import { Redis } from 'ioredis'
import { apiLogger } from '@/lib/logger'

export interface Cache {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T, ttlMs: number): Promise<void>
  del(key: string): Promise<void>
  /** Atomically add `amount` to a counter, returning the new total. Sets the TTL
   *  window on first increment. Used for the cross-process token-usage counter. */
  incrBy(key: string, amount: number, ttlMs: number): Promise<number>
}

const BIGINT_TAG = '$backstoryCacheBigInt'

/** JSON wire format that preserves Prisma BigInt fields instead of throwing. */
export function cacheStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    typeof entry === 'bigint' ? { [BIGINT_TAG]: entry.toString() } : entry,
  )
}

export function cacheParse<T>(raw: string): T {
  return JSON.parse(raw, (_key, entry) => {
    if (
      entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      Object.keys(entry).length === 1 &&
      typeof (entry as Record<string, unknown>)[BIGINT_TAG] === 'string' &&
      /^-?\d+$/.test((entry as Record<string, string>)[BIGINT_TAG])
    ) {
      return BigInt((entry as Record<string, string>)[BIGINT_TAG])
    }
    return entry
  }) as T
}

// Bounds the in-memory fallback so a long-lived process can't grow unbounded.
const MAX_MEMORY_ENTRIES = 5000

function createMemoryCache(): Cache {
  const store = new Map<string, { value: unknown; expiresAt: number }>()
  return {
    async get<T>(key: string): Promise<T | null> {
      const hit = store.get(key)
      if (!hit) return null
      if (hit.expiresAt <= Date.now()) {
        store.delete(key)
        return null
      }
      // Touch for LRU-ish ordering (Map preserves insertion order).
      store.delete(key)
      store.set(key, hit)
      return hit.value as T
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      if (store.size >= MAX_MEMORY_ENTRIES && !store.has(key)) {
        const oldest = store.keys().next().value
        if (oldest !== undefined) store.delete(oldest)
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs })
    },
    async del(key: string): Promise<void> {
      store.delete(key)
    },
    async incrBy(key: string, amount: number, ttlMs: number): Promise<number> {
      const now = Date.now()
      const hit = store.get(key)
      const live = hit !== undefined && hit.expiresAt > now
      const current = live && typeof hit!.value === 'number' ? (hit!.value as number) : 0
      const next = current + amount
      if (store.size >= MAX_MEMORY_ENTRIES && !store.has(key)) {
        const oldest = store.keys().next().value
        if (oldest !== undefined) store.delete(oldest)
      }
      store.set(key, { value: next, expiresAt: live ? hit!.expiresAt : now + ttlMs })
      return next
    },
  }
}

/**
 * Upstash Redis over its REST API (HTTP + Bearer) — the ideal cache backend on
 * serverless (Vercel), where long-lived TCP connections churn. No SDK needed:
 * the REST protocol is a POST of a command array. Best-effort like the others.
 */
function createUpstashRestCache(url: string, token: string): Cache {
  const base = url.replace(/\/$/, '')
  const run = async (command: (string | number)[]): Promise<unknown> => {
    const res = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) throw new Error(`Upstash REST ${res.status}`)
    return (await res.json() as { result?: unknown }).result ?? null
  }
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = await run(['GET', key])
      return typeof raw === 'string' ? cacheParse<T>(raw) : null
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      await run(['SET', key, cacheStringify(value), 'PX', Math.max(1, Math.floor(ttlMs))])
    },
    async del(key: string): Promise<void> {
      await run(['DEL', key])
    },
    async incrBy(key: string, amount: number, ttlMs: number): Promise<number> {
      const next = Number(await run(['INCRBY', key, amount]))
      if (next === amount) await run(['PEXPIRE', key, Math.max(1, Math.floor(ttlMs))])
      return next
    },
  }
}

function createRedisCache(url: string): Cache {
  // Fail fast (best-effort): one retry, no ready-check, lazy connect so an
  // unreachable Redis degrades to source-of-truth reads instead of hanging.
  const redis = new Redis(url, { maxRetriesPerRequest: 1, enableReadyCheck: false, lazyConnect: true })
  let warned = false
  redis.on('error', (error: Error) => {
    if (warned) return
    warned = true
    apiLogger.warn('cache: redis error (falling through to source)', { error: error.message })
  })
  return {
    async get<T>(key: string): Promise<T | null> {
      const raw = await redis.get(key)
      return raw ? cacheParse<T>(raw) : null
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      await redis.set(key, cacheStringify(value), 'PX', Math.max(1, Math.floor(ttlMs)))
    },
    async del(key: string): Promise<void> {
      await redis.del(key)
    },
    async incrBy(key: string, amount: number, ttlMs: number): Promise<number> {
      const next = await redis.incrby(key, amount)
      // First increment created the key → stamp its TTL window.
      if (next === amount) await redis.pexpire(key, Math.max(1, Math.floor(ttlMs)))
      return next
    },
  }
}

let instance: Cache | null = null

export function getCache(): Cache {
  if (instance) return instance
  // Prefer Upstash REST (serverless-native), then an ioredis TCP URL, then a
  // bounded in-memory fallback.
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN
  const redisUrl = process.env.REDIS_URL
  if (upstashUrl && upstashToken) instance = createUpstashRestCache(upstashUrl, upstashToken)
  else if (redisUrl) instance = createRedisCache(redisUrl)
  else instance = createMemoryCache()
  return instance
}

/** True when a shared cache is configured (Upstash REST or Redis); false = memory. */
export function cacheConfigured(): boolean {
  return Boolean((process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) || process.env.REDIS_URL)
}

function warn(op: string, key: string, error: unknown): void {
  apiLogger.warn(`cache.${op} failed`, { key, error: error instanceof Error ? error.message : String(error) })
}

/** Best-effort get; returns null on miss or any backend error. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    return await getCache().get<T>(key)
  } catch (error) {
    warn('get', key, error)
    return null
  }
}

/** Best-effort set; swallows backend errors. */
export async function cacheSet<T>(key: string, value: T, ttlMs: number): Promise<void> {
  try {
    await getCache().set(key, value, ttlMs)
  } catch (error) {
    warn('set', key, error)
  }
}

/** Best-effort atomic increment; returns the new total, or null on backend error. */
export async function cacheIncrBy(key: string, amount: number, ttlMs: number): Promise<number | null> {
  try {
    return await getCache().incrBy(key, amount, ttlMs)
  } catch (error) {
    warn('incrBy', key, error)
    return null
  }
}

/** Best-effort numeric get (for counters); null on miss or non-numeric. */
export async function cacheGetNumber(key: string): Promise<number | null> {
  const value = await cacheGet<number>(key)
  return typeof value === 'number' ? value : null
}

/** Best-effort delete (cache busting); swallows backend errors. */
export async function cacheDelete(key: string): Promise<void> {
  try {
    await getCache().del(key)
  } catch (error) {
    warn('del', key, error)
  }
}

/**
 * Read-through: return the cached value, else run `fetcher`, cache a
 * non-null/undefined result under `ttlMs`, and return it. Negatives are not
 * cached (so a failed fetch isn't pinned). Cache errors never propagate.
 */
export async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  const hit = await cacheGet<T>(key)
  if (hit !== null && hit !== undefined) return hit
  const value = await fetcher()
  if (value !== null && value !== undefined) await cacheSet(key, value, ttlMs)
  return value
}

/**
 * Health probe for the cache backend. `configured` = Redis is the backend (a
 * shared cache); `ok` = a set/get round-trip succeeds. So (configured:true,
 * ok:false) means REDIS_URL is set but Redis is unreachable; (configured:false,
 * ok:true) means the in-memory fallback (no Redis). Best-effort — never throws.
 */
export async function cachePing(): Promise<{ configured: boolean; ok: boolean }> {
  const configured = cacheConfigured()
  const probeKey = '__health_probe__'
  const token = String(Date.now())
  await cacheSet(probeKey, token, 5_000)
  const ok = (await cacheGet<string>(probeKey)) === token
  return { configured, ok }
}
