import { prisma } from '@/lib/prisma'
import { cacheDelete, cacheGetNumber, cacheIncrBy } from '@/lib/cache'

// Live month-to-date token counter, keyed per org + UTC month. Incremented per
// turn as tokens are spent, so concurrent runs/workers see each other's spend
// immediately (the DB columns are only written at run end). TTL just cleans up
// old months; the key rolls over each month.
const MONTH_TTL_MS = 35 * 24 * 60 * 60 * 1000
function monthKey(organizationId: string): string {
  const now = new Date()
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  return `usage:${organizationId}:${ym}`
}

/**
 * Sibling key to monthKey, for chars/4 ESTIMATES (endpoints whose model helper
 * returns no real usage). Kept separate from the reported-usage key so a
 * surface that shows month-to-date spend can distinguish "measured" from
 * "guessed" — enforcement (checkMonthlyTokenBudget) sums both, since an
 * estimate still represents real tokens spent, just not precisely counted.
 */
function estimatedMonthKey(organizationId: string): string {
  return `${monthKey(organizationId)}:est`
}

/**
 * Record token spend against the live month-to-date counter. Call per turn.
 * Best-effort (returns the new total, or null if the counter backend is down).
 *
 * Pass `{ estimated: true }` when the count is a chars/4 guess rather than
 * provider-reported usage — it lands in a sibling Redis key so estimated and
 * measured spend never share (and silently blend into) the same number, while
 * still counting toward enforcement (see checkMonthlyTokenBudget).
 */
export async function recordTokenUsage(
  organizationId: string,
  tokens: number,
  opts?: { estimated?: boolean },
): Promise<number | null> {
  if (!Number.isFinite(tokens) || tokens <= 0) return null
  const key = opts?.estimated ? estimatedMonthKey(organizationId) : monthKey(organizationId)
  return cacheIncrBy(key, Math.floor(tokens), MONTH_TTL_MS)
}

/**
 * Clear this workspace's month-to-date token counters (both the reported and
 * estimated keys), so a workspace stopped by the monthly ceiling can run again
 * immediately.
 *
 * Deliberately WORKSPACE-scoped, because the counter is: the key is per org per
 * UTC month, and there is no per-person breakdown to clear. An operator screen
 * offering this per user has to say so, or it reads as "reset one person" while
 * quietly lifting the ceiling for their whole workspace.
 *
 * Lives here rather than in the route so the key format has exactly one owner —
 * a reset that computed the key itself would silently stop matching the moment
 * monthKey changed, and the failure mode is a button that appears to work.
 */
export async function resetMonthlyTokenUsage(organizationId: string): Promise<void> {
  await Promise.all([
    cacheDelete(monthKey(organizationId)),
    cacheDelete(estimatedMonthKey(organizationId)),
  ])
}

/**
 * Per-entitlement-tier monthly token ceilings (total input+output per UTC
 * month). A workspace's tier comes from its People.ai entitlement snapshot
 * (Organization.entitlementTier). The env var AGENT_MONTHLY_TOKEN_LIMIT is a
 * global override/floor for environments without tiers.
 *
 * 0 means unlimited. Tune these as commercial tiers firm up.
 */
export const TIER_MONTHLY_TOKEN_LIMITS: Record<string, number> = {
  sales_ai: 20_000_000,
}

// Runaway backstop for orgs with no explicit tier or env limit. Sized well above
// normal use (~50 full 2M-token runs/month) but far below the ~482M a recursive
// sub-agent fan-out could burn from a single click. Set AGENT_MONTHLY_TOKEN_LIMIT
// (incl. an explicit 0 = unlimited) to override.
const DEFAULT_MONTHLY_TOKEN_LIMIT = 100_000_000

// Accounts exempt from the monthly token ceiling (internal admins). The default
// covers the platform admin; add more via USAGE_EXEMPT_EMAILS (comma-separated).
const DEFAULT_EXEMPT_EMAILS = ['james.mcdaniel@people.ai', 'james.mcdaniel@backstory.ai']

/** True when this email should never be blocked by the usage ceiling. */
export function isUsageExemptEmail(email: string | null | undefined): boolean {
  if (!email) return false
  const extra = (process.env.USAGE_EXEMPT_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const exempt = new Set([...DEFAULT_EXEMPT_EMAILS, ...extra])
  return exempt.has(email.trim().toLowerCase())
}

export function tokenLimitForTier(tier: string | null | undefined): number {
  const tierLimit = tier ? (TIER_MONTHLY_TOKEN_LIMITS[tier] ?? 0) : 0
  const raw = process.env.AGENT_MONTHLY_TOKEN_LIMIT
  // An explicitly set env var wins — including an explicit 0, which is the
  // documented way to opt back into unlimited. (Distinguished from "unset" so
  // the default floor below can't silently override an operator's `=0`.)
  if (raw !== undefined && raw.trim() !== '') {
    const envLimit = Number(raw)
    if (Number.isFinite(envLimit) && envLimit >= 0) {
      if (envLimit > 0 && tierLimit > 0) return Math.max(envLimit, tierLimit) // both set → more permissive
      return envLimit // includes explicit 0 = unlimited
    }
  }
  // No env override: the tier limit if any, else the runaway backstop (never 0,
  // so enforcement is on by default rather than opt-in).
  return tierLimit > 0 ? tierLimit : DEFAULT_MONTHLY_TOKEN_LIMIT
}

/**
 * The enforced month-to-date token ceiling for a workspace — the same number
 * checkMonthlyTokenBudget gates runs against, exposed standalone so display
 * surfaces (the sidebar's credits bar, /api/snapshot, /api/usage) can show the
 * real denominator instead of an unrelated hardcoded constant.
 */
export async function monthlyTokenBudgetFor(organizationId: string): Promise<number> {
  const org = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { entitlementTier: true },
  })
  return tokenLimitForTier(org?.entitlementTier)
}

/**
 * Month-to-date token budget for an organization. Enforced at the start of every
 * agent run so a runaway agent (or an expired trial) can't burn unbounded spend.
 *
 * The ceiling is the workspace's entitlement-tier limit, or a generous default
 * backstop when there's no tier; AGENT_MONTHLY_TOKEN_LIMIT overrides it (set it
 * to 0 to opt back into unlimited). Enforcement is ON by default.
 */
export async function checkMonthlyTokenBudget(
  organizationId: string,
  userId?: string | null,
): Promise<{ over: boolean; used: number; limit: number }> {
  // Exempt accounts (internal admins) are never blocked.
  if (userId) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } })
    if (isUsageExemptEmail(user?.email)) return { over: false, used: 0, limit: 0 }
  }

  const limit = await monthlyTokenBudgetFor(organizationId)
  if (limit <= 0) return { over: false, used: 0, limit: 0 }

  const since = new Date()
  since.setUTCDate(1)
  since.setUTCHours(0, 0, 0, 0)

  // LlmCall covers BOTH planes (agent turns AND flow AI steps) — unlike
  // agentExecution, which only the agent plane ever wrote to, and so silently
  // under-counted any workspace that mostly runs flows.
  const aggregate = await prisma.llmCall.aggregate({
    where: { organizationId, createdAt: { gte: since } },
    _sum: { inputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, outputTokens: true },
  })
  const dbUsed =
    (aggregate._sum.inputTokens || 0) +
    (aggregate._sum.cacheWriteTokens || 0) +
    (aggregate._sum.cacheReadTokens || 0) +
    (aggregate._sum.outputTokens || 0)

  // The live counters include in-flight runs the DB aggregate can't see yet, so
  // their sum is normally the higher (and correct) number. Reported and
  // estimated usage are sibling keys (see recordTokenUsage) — enforcement sums
  // both, since an estimate still represents real spend. Fall back to the DB
  // total if both are unavailable or were reset mid-month, so we never
  // under-count.
  const [liveReported, liveEstimated] = await Promise.all([
    cacheGetNumber(monthKey(organizationId)),
    cacheGetNumber(estimatedMonthKey(organizationId)),
  ])
  const live = (liveReported ?? 0) + (liveEstimated ?? 0)
  const used = Math.max(dbUsed, live)

  return { over: used >= limit, used, limit }
}
