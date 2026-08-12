/**
 * Hard per-person ceilings for everyone who is not a super admin.
 *
 * Distinct from the monthly TOKEN budget in budget.ts, which bounds spend for a
 * whole workspace. These bound COUNT — how many runs a person may start in a
 * day and how many integrations they may connect — so a single account cannot
 * burn the platform's credits before any token ceiling is approached.
 *
 * Exempt: super admins, meaning the platform owner identities and anyone
 * promoted through the Reviews console. `catalogue.review` is the permission
 * behind that console, so holding it IS being a super admin — one check rather
 * than a second list that could drift from the first.
 */
import { prisma } from '@/lib/prisma'
import { isUsageExemptEmail } from '@/lib/usage/budget'
import { listConnectedProviders, type ConnectedProvider } from '@/lib/integrations/connected'

export const FREE_TIER_LIMITS = {
  /** Agent runs a person may START per UTC day. */
  agentRunsPerDay: 5,
  /** Flow runs a person may START per UTC day. */
  flowRunsPerDay: 5,
  /** Connected integrations per workspace, excluding MCP servers and HTTP APIs. */
  integrations: 3,
} as const

export type RunKind = 'agent' | 'flow'

export interface AllowanceResult {
  /** True when the actor is at or past the ceiling and must be refused. */
  over: boolean
  used: number
  limit: number
}

/** Midnight UTC for the day `now` falls in. The window every daily cap counts. */
export function startOfUtcDay(now: Date = new Date()): Date {
  const start = new Date(now)
  start.setUTCHours(0, 0, 0, 0)
  return start
}

/**
 * Where the daily-cap window starts for this person: midnight UTC, or the
 * operator's reset stamp when that is LATER.
 *
 * The `later of` is the safety property, not a detail. The cap is counted from
 * run rows, which cannot be un-counted, so a reset can only move the window
 * forward. Taking the earlier value would let a stale stamp from a previous day
 * widen the window and count runs the cap should already have forgotten —
 * turning a one-off grant into a permanent exemption.
 *
 * Pure, so the rule is unit-testable without a database or a clock.
 */
export function runWindowStart(resetAt: Date | null | undefined, now: Date = new Date()): Date {
  const midnight = startOfUtcDay(now)
  return resetAt && resetAt > midnight ? resetAt : midnight
}

/**
 * True when this actor is exempt from every ceiling here.
 *
 * Pure — the caller supplies the two facts, so the rule is unit-testable and
 * cannot silently start reading env or the database.
 */
export function isUnlimitedActor(actor: { canReview: boolean; email?: string | null }): boolean {
  return actor.canReview || isUsageExemptEmail(actor.email)
}

/**
 * The integrations that count against {@link FREE_TIER_LIMITS.integrations}.
 *
 * MCP servers are excluded by product decision: they are how a workspace brings
 * its OWN tools, and capping them would cap the platform's extensibility rather
 * than its cost. HTTP credentials never appear in this list at all — they are a
 * separate plane (HttpCredential), not a connected provider. What remains is
 * what a person deliberately connected: Nango OAuth accounts, plus a workspace's
 * own Granola/Slack credential.
 */
export function countableIntegrations(providers: Pick<ConnectedProvider, 'plane'>[]): number {
  return providers.filter((provider) => provider.plane !== 'mcp').length
}

/**
 * Whether this person may start another run today.
 *
 * Counts EVERY run they own for the day, not just manually started ones, so
 * scheduling a run does not become a way around the interactive cap. The cap is
 * per person rather than per workspace: it bounds what one account can spend,
 * which is what the ceiling is for.
 */
export async function checkDailyRunAllowance(
  kind: RunKind,
  args: { organizationId: string; userId: string; canReview: boolean; email?: string | null },
): Promise<AllowanceResult> {
  const limit = kind === 'agent' ? FREE_TIER_LIMITS.agentRunsPerDay : FREE_TIER_LIMITS.flowRunsPerDay
  if (isUnlimitedActor(args)) return { over: false, used: 0, limit: 0 }

  // One extra read, only for people who are actually capped: an operator may
  // have granted this person a fresh allowance part-way through the day.
  const actor = await prisma.user.findUnique({
    where: { id: args.userId },
    select: { runAllowanceResetAt: true },
  })
  const since = runWindowStart(actor?.runAllowanceResetAt)
  const where = { organizationId: args.organizationId, userId: args.userId, startedAt: { gte: since } }
  const used =
    kind === 'agent'
      ? await prisma.agentExecution.count({ where })
      : await prisma.flowRun.count({ where })

  return { over: used >= limit, used, limit }
}

/** Whether this workspace may connect another integration. */
export async function checkIntegrationAllowance(args: {
  organizationId: string
  userId: string
  canReview: boolean
  email?: string | null
}): Promise<AllowanceResult> {
  if (isUnlimitedActor(args)) return { over: false, used: 0, limit: 0 }

  const providers = await listConnectedProviders(args.organizationId, args.userId)
  const used = countableIntegrations(providers)
  return { over: used >= FREE_TIER_LIMITS.integrations, used, limit: FREE_TIER_LIMITS.integrations }
}

/** The message a refused actor sees. Plain English, no enum or quota jargon. */
export function limitMessage(kind: RunKind | 'integration', limit: number): string {
  if (kind === 'integration') {
    return `This workspace has reached its limit of ${limit} connected integrations. Disconnect one, or ask a workspace owner to raise the limit.`
  }
  const noun = kind === 'agent' ? 'agent runs' : 'flow runs'
  return `You have used all ${limit} ${noun} for today. The limit resets at midnight UTC.`
}
