/**
 * Shared rate limiter.
 *
 * Sliding-window counter, keyed by caller-chosen strings (e.g. `signals:<ip>`,
 * `trigger:<agentId>`). In-memory by default — correct per serverless instance
 * and per worker process, which is sufficient to blunt abuse on public
 * endpoints. When REDIS_URL is set (worker/queue deployments), a Redis-backed
 * window makes the limit global across processes.
 */

import { Redis } from 'ioredis'

export interface RateLimitOptions {
  limit: number
  windowMs: number
  /** Public ingress may choose availability-safe denial when Redis is down. */
  failureMode?: 'open' | 'closed'
}

export interface RateLimitResult {
  ok: boolean
  retryAfterMs?: number
}

export interface RateLimiter {
  check(key: string, options: RateLimitOptions): Promise<RateLimitResult>
}

interface CreateOptions {
  now?: () => number
  redisUrl?: string
}

export function createRateLimiter(create: CreateOptions = {}): RateLimiter {
  const now = create.now ?? Date.now
  const redisUrl = create.redisUrl ?? process.env.REDIS_URL
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN

  if (!create.now) {
    // Prefer Upstash REST on serverless: an ioredis TCP connection per lambda
    // instance pays a TLS handshake on cold start and churns connections under
    // scale-out; the REST protocol is a plain HTTPS call. Explicit redisUrl
    // (tests/worker overrides) still selects the TCP limiter.
    if (!create.redisUrl && upstashUrl && upstashToken) return createUpstashRestLimiter(upstashUrl, upstashToken)
    if (redisUrl) return createRedisLimiter(redisUrl)
  }
  return createMemoryLimiter(now)
}

function createMemoryLimiter(now: () => number): RateLimiter {
  const hits = new Map<string, number[]>()

  return {
    async check(key, { limit, windowMs }) {
      const cutoff = now() - windowMs
      const timestamps = (hits.get(key) ?? []).filter((t) => t > cutoff)

      if (timestamps.length >= limit) {
        hits.set(key, timestamps)
        const oldest = timestamps[0]
        return { ok: false, retryAfterMs: Math.max(1, oldest + windowMs - now()) }
      }

      timestamps.push(now())
      hits.set(key, timestamps)

      // Opportunistic cleanup so long-lived processes don't accumulate keys.
      if (hits.size > 10_000) {
        for (const [candidate, stamps] of hits) {
          if (stamps.every((t) => t <= cutoff)) hits.delete(candidate)
        }
      }

      return { ok: true }
    },
  }
}

/**
 * Upstash REST fixed-window limiter — the same INCR + PEXPIRE-on-first-hit
 * algorithm as the TCP limiter, over one pipelined HTTPS call. Callers choose
 * whether a backend outage fails open or closed.
 */
function createUpstashRestLimiter(url: string, token: string): RateLimiter {
  const base = url.replace(/\/$/, '')
  return {
    async check(key, { limit, windowMs, failureMode }) {
      try {
        const redisKey = `ratelimit:${key}`
        // Pipeline: INCR, then PEXPIRE NX (only sets the TTL when absent — the
        // first hit of a window), then PTTL for retry-after.
        const res = await fetch(`${base}/pipeline`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify([
            ['INCR', redisKey],
            ['PEXPIRE', redisKey, windowMs, 'NX'],
            ['PTTL', redisKey],
          ]),
          signal: AbortSignal.timeout(3_000),
        })
        if (!res.ok) return failureMode === 'closed' ? { ok: false, retryAfterMs: 1_000 } : { ok: true }
        const results = (await res.json()) as Array<{ result?: unknown }>
        const count = Number(results[0]?.result ?? 0)
        if (count > limit) {
          const ttl = Number(results[2]?.result ?? windowMs)
          return { ok: false, retryAfterMs: Math.max(1, ttl) }
        }
        return { ok: true }
      } catch {
        return failureMode === 'closed' ? { ok: false, retryAfterMs: 1_000 } : { ok: true }
      }
    },
  }
}

function createRedisLimiter(redisUrl: string): RateLimiter {
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true })

  return {
    async check(key, { limit, windowMs, failureMode }) {
      try {
        const redisKey = `ratelimit:${key}`
        const count = await redis.incr(redisKey)
        if (count === 1) await redis.pexpire(redisKey, windowMs)
        if (count > limit) {
          const ttl = await redis.pttl(redisKey)
          return { ok: false, retryAfterMs: Math.max(1, ttl) }
        }
        return { ok: true }
      } catch {
        return failureMode === 'closed' ? { ok: false, retryAfterMs: 1_000 } : { ok: true }
      }
    },
  }
}

/** Process-wide default limiter for route handlers. */
let defaultLimiter: RateLimiter | null = null

export function rateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  defaultLimiter ??= createRateLimiter()
  return defaultLimiter.check(key, options)
}
