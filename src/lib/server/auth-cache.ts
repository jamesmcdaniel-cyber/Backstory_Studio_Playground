/**
 * A shared-backend cache for the per-request user row, with write-through
 * invalidation at the Prisma chokepoint.
 *
 * ── What this replaces, and what it must not repeat ───────────────────────
 * There used to be a `dbUserCache`: a module-level Map with a 60s TTL holding
 * the user row and its organization. It was removed rather than tuned, for a
 * reason worth restating, because this file is the thing that could bring the
 * bug back:
 *
 *   Every field the row carries is an AUTHORITY field — organizationId, role,
 *   platformRole, isActive. There is no subset that is safe to serve stale. And
 *   a module-level Map is per-instance, so invalidating it on the lambda that
 *   handled a mutation was invisible to every other warm instance. A demoted
 *   admin kept members.manage for up to a minute. A removed member kept full
 *   workspace access for up to a minute, on every instance but one.
 *
 * The comment left behind in auth-utils.ts named the only acceptable
 * replacement: a shared-backend cache with explicit invalidation, never a
 * per-instance one. This is that, with one addition — the invalidation is not
 * left to call sites.
 *
 * ── Why the read is worth caching at all ──────────────────────────────────
 * One indexed lookup per authenticated request is cheap in isolation. At 1,000
 * concurrent users it is ~125 req/s from the shell poll alone, before any real
 * work, on the same connection pool everything else contends for. It is the one
 * query literally every authenticated request makes.
 *
 * ── Why invalidation lives in the Prisma extension ────────────────────────
 * Explicit invalidation is correct and forgettable, and the forgotten call site
 * is exactly how the original bug reached production: two member routes (role
 * change, removal) never invalidated at all. So `noteUserMutation` is driven
 * from the same chokepoint as the tenant guard — every write to a `User` row
 * evicts that user's entry, on every instance, whether or not whoever wrote the
 * route remembered this file exists.
 *
 * ── The residual staleness, stated exactly ────────────────────────────────
 * User-row writes evict immediately and globally, which covers deactivation,
 * role change, platform role, and organization transfer — the whole authority
 * set that motivated the removal.
 *
 * What the eviction does NOT catch is a write to the ORGANIZATION row, whose
 * fields ride along on the cached `include`. Resolving those to their members
 * would take a fan-out this path cannot afford, so they are bounded by the TTL
 * instead: at most AUTH_CACHE_TTL_MS of staleness on the workspace name, plan,
 * logo, and entitlement tier. The first three are display. The fourth gates
 * access — and is re-checked at dispatch time against the live row, so a run
 * cannot start on a stale tier regardless of what this cache last saw.
 *
 * Ten seconds, not sixty, and the difference is the point: it is a backstop for
 * the one class of change eviction cannot see, not the invalidation mechanism.
 *
 * ── On secrets ────────────────────────────────────────────────────────────
 * The organization row carries `peopleAiWebhookSecret`, encrypted at rest. What
 * lands in Redis is therefore ciphertext, and ENCRYPTION_KEY is not in Redis —
 * so the cache never holds anything that is useful on its own.
 *
 * Fails OPEN in the safe direction: with no cache backend configured, or one
 * that is down, every read misses and every request queries Postgres exactly as
 * it did before this file existed.
 */
import { cacheGet, cacheSet, cacheDelete, cacheConfigured } from '@/lib/cache'

const AUTH_CACHE_TTL_MS = Math.max(1_000, Number(process.env.AUTH_CACHE_TTL_MS) || 10_000)

function userKey(supabaseId: string): string {
  return `auth:user:${supabaseId}`
}

/**
 * Reverse pointer, user id → supabase id.
 *
 * The cache is keyed by supabaseId because that is what an incoming request
 * presents, but almost every write targets the row by its primary key. Without
 * this, an id-keyed update could not find the entry to evict — which is the
 * precise shape of the original bug, and not one to reintroduce for the sake of
 * one fewer key. Given a longer TTL than the entry it points at so it cannot
 * expire first and orphan the thing it exists to reach.
 */
function reverseKey(userId: string): string {
  return `auth:rev:${userId}`
}

/**
 * Prisma returns Date instances; JSON does not. Every DateTime column on User
 * and Organization ends in `At` or `Date` (lastSeenAt, runAllowanceResetAt,
 * createdAt, updatedAt, entitlementCheckedAt, trialStartDate, trialEndDate), so
 * the suffix is a reliable discriminator here — and a string that merely looks
 * like a date under some other name is left alone rather than silently retyped.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

export function reviveDates<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => reviveDates(entry)) as unknown as T
  if (!value || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === 'string' && /(At|Date)$/.test(key) && ISO_DATE.test(entry)) {
      result[key] = new Date(entry)
    } else if (entry && typeof entry === 'object') {
      result[key] = reviveDates(entry)
    } else {
      result[key] = entry
    }
  }
  return result as T
}

/** The cached row for this identity, or null on a miss / no backend. */
export async function readCachedAuthUser<T>(supabaseId: string): Promise<T | null> {
  if (!cacheConfigured()) return null
  try {
    const hit = await cacheGet<T>(userKey(supabaseId))
    return hit ? reviveDates(hit) : null
  } catch {
    return null
  }
}

/**
 * Cache a resolved row. Best-effort: a failure here costs a query next time and
 * nothing else, so it is never allowed to fail an authenticated request.
 */
export async function writeCachedAuthUser(
  supabaseId: string,
  userId: string,
  row: unknown,
): Promise<void> {
  if (!cacheConfigured() || !row) return
  try {
    await Promise.all([
      cacheSet(userKey(supabaseId), row, AUTH_CACHE_TTL_MS),
      cacheSet(reverseKey(userId), supabaseId, AUTH_CACHE_TTL_MS * 6),
    ])
  } catch {
    // Ignored by design — see above.
  }
}

/** Evict by whichever identifier the caller has. */
export async function invalidateAuthUser(args: { supabaseId?: string; userId?: string }): Promise<void> {
  if (!cacheConfigured()) return
  try {
    if (args.supabaseId) await cacheDelete(userKey(args.supabaseId))
    if (args.userId) {
      const mapped = await cacheGet<string>(reverseKey(args.userId))
      if (mapped) await cacheDelete(userKey(mapped))
    }
  } catch {
    // See above.
  }
}

const WRITE_OPERATIONS = new Set([
  'create', 'createMany', 'createManyAndReturn',
  'update', 'updateMany', 'updateManyAndReturn',
  'upsert', 'delete', 'deleteMany',
])

/**
 * Identify a write to a `User` row and evict the affected entry.
 *
 * Driven from the Prisma extension so no route has to remember. Returns the
 * eviction promise rather than awaiting it internally so the caller decides
 * whether the request waits — and it MUST wait: this is authority data, and a
 * response that returns before the eviction lands could be followed
 * immediately by a request that reads the pre-write row.
 */
export function noteUserMutation(
  model: string | undefined,
  operation: string,
  args: unknown,
): Promise<void> | null {
  if (model !== 'User' || !WRITE_OPERATIONS.has(operation)) return null
  const where = (args as { where?: Record<string, unknown> } | undefined)?.where
  const supabaseId = typeof where?.supabaseId === 'string' ? where.supabaseId : undefined
  const userId = typeof where?.id === 'string' ? where.id : undefined

  if (!supabaseId && !userId) {
    // An `updateMany` selecting by something else — organizationId, an email
    // list, isActive. The rows it touched cannot be named from the args, so
    // there is nothing precise to evict and the TTL is the only bound. Rare,
    // and deliberately not solved by flushing every entry: that would hand any
    // bulk write the ability to empty the cache platform-wide.
    return null
  }
  return invalidateAuthUser({ supabaseId, userId })
}
