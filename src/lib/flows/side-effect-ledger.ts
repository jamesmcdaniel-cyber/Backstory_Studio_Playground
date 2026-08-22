import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'

/**
 * Read-before-write / write-after-success around every flow side effect.
 *
 * Why a ledger and not just headers: `withIdempotencyHeader` reached exactly one
 * call site (the HTTP step), and most Nango/MCP providers ignore an
 * unrecognized `idempotency-key` anyway. The ledger is provider-agnostic — it
 * makes a replay a local no-op regardless of what the provider supports, which
 * is the only thing that covers Slack posts, Gmail sends, and Drive uploads.
 */

export const LEDGER_REPLAY_WARNING =
  'This step was replayed from an earlier attempt — the recorded result was reused and the action was not run again.'

type TriggerLike = { type?: unknown; dedupeValue?: unknown }

/**
 * The idempotency scope for a run.
 *
 * Poll-triggered runs scope by the polled ITEM, not the run: poll-dispatch.ts is
 * deliberately at-least-once (dispatch, then persist the cursor — losing an item
 * is worse than repeating one), so a crash between the two re-emits the same
 * item as a brand new run with a new id. Sharing the scope is what makes that
 * second run replay instead of firing the writes again.
 *
 * Activity/Slack-triggered runs (the activity-event substrate's dispatcher,
 * src/lib/activity/dispatch.ts) scope by the `ActivityEvent` id the same way:
 * exactly-once dispatch is already enforced by `ActivityTriggerClaim`'s unique
 * `[organizationId, activityEventId, flowId]` index, but should the dispatcher
 * ever be re-run for an event it already claimed for this flow (a replay, a
 * manual retry), the run's own side effects still must not fire twice — same
 * reasoning as poll's dedupeValue.
 *
 * Falls back to the run id whenever there is no single item to key on — the
 * batch-dispatch shape, or a malformed trigger. That is exactly today's
 * behavior, so the fallback is safe rather than merely defensive.
 */
export function runScopeKey(run: { id: string; flowId: string; trigger: unknown }): string {
  const trigger = (run.trigger && typeof run.trigger === 'object' ? run.trigger : {}) as TriggerLike
  const dedupeValue = typeof trigger.dedupeValue === 'string' ? trigger.dedupeValue.trim() : ''
  if ((trigger.type === 'poll' || trigger.type === 'activity' || trigger.type === 'slack') && dedupeValue) {
    return `${run.flowId}:${dedupeValue}`
  }
  return run.id
}

export type LedgerKey = { scopeKey: string; iterationKey: string; page: number }

/**
 * The recorded result of a completed side effect, or null when it is new.
 *
 * `organizationId` is required and part of the predicate, not decoration: the
 * scope triple alone is globally unique but NOT tenant-bound, so an unscoped
 * read could hand one workspace's recorded Slack response to another
 * workspace's flow on a scope collision. findFirst rather than findUnique for
 * the same reason — the compound unique key has no org in it. The unique index
 * still serves the lookup.
 */
export async function readLedger(
  key: LedgerKey & { organizationId: string },
): Promise<{ result: unknown } | null> {
  try {
    const row = await prisma.flowSideEffect.findFirst({
      where: {
        scopeKey: key.scopeKey,
        iterationKey: key.iterationKey,
        page: key.page,
        organizationId: key.organizationId,
      },
      select: { result: true },
    })
    return row ? { result: row.result } : null
  } catch (error) {
    // A ledger read failure must not fail the step: worst case we re-execute,
    // which is exactly the behavior that existed before this ledger.
    apiLogger.warn('side-effect ledger read failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Record a completed side effect. A conflict means a concurrent attempt won the
 * race and its result stands — not an error worth surfacing.
 */
export async function writeLedger(
  params: LedgerKey & {
    organizationId: string
    provider: string
    tool: string
    result: unknown
    flowRunId: string | null
  },
): Promise<void> {
  try {
    await prisma.flowSideEffect.create({
      data: {
        scopeKey: params.scopeKey,
        iterationKey: params.iterationKey,
        page: params.page,
        organizationId: params.organizationId,
        provider: params.provider,
        tool: params.tool,
        result: (params.result ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        flowRunId: params.flowRunId,
      },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return
    apiLogger.warn('side-effect ledger write failed', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
