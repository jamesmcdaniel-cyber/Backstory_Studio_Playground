import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { KNOWN_SIGNALS } from '@/lib/flows/trigger'
import { triggerConditionPasses } from '@/lib/flows/trigger-condition'
import { dispatchFlowExecution } from './execute-flow'

// Re-exported so callers (including the client-safe builder UI) can import the
// known signal catalog from either module; the canonical list lives in
// lib/flows/trigger.ts because it must stay prisma-free.
export { KNOWN_SIGNALS }

// Signal-triggered runs carry a depth on their run trigger (incremented by the
// emitter one level up); once a chain reaches this depth the signal is dropped
// instead of fired, so a flow.completed -> flow.completed -> ... loop can't run
// forever.
export const SIGNAL_DEPTH_CAP = 3

// Bound how many ACTIVE org flows are scanned for listeners per emit.
const MAX_FLOWS_PER_EMIT = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/**
 * Pure match check: does this flow's trigger listen for `signal`? Requires the
 * flow to be ACTIVE, published (a draft-only flow never fires on a signal),
 * and its trigger to be a signal trigger naming exactly this signal.
 */
export function flowListensTo(
  flow: { trigger: unknown; publishedGraph: unknown; status: string },
  signal: string,
): boolean {
  if (flow.status !== 'ACTIVE') return false
  if (flow.publishedGraph == null) return false
  if (!isRecord(flow.trigger)) return false
  return flow.trigger.type === 'signal' && flow.trigger.signal === signal
}

/** Pure: read the signal depth off a run trigger, defaulting to 0. */
export function signalDepthOf(trigger: unknown): number {
  if (!isRecord(trigger)) return 0
  return typeof trigger.depth === 'number' ? trigger.depth : 0
}

/**
 * Fire a signal to every ACTIVE, published, listening flow in the org. Runs
 * are awaited sequentially, each isolated by its own try/catch so one flow's
 * failure never blocks the rest — callers fire-and-forget the whole call.
 *
 * The depth cap is enforced BEFORE any DB query so a runaway signal chain
 * never even loads the flow list.
 */
export async function emitFlowSignal(params: {
  organizationId: string
  signal: string
  payload: unknown
  sourceFlowId?: string
  depth?: number
  /** Stable outbox id used to deduplicate queue handoff after a crash. */
  deliveryId?: string
  /** Durable outbox delivery retries when any matching handoff fails. */
  strictDelivery?: boolean
}): Promise<{ matched: number }> {
  const depth = params.depth ?? 0
  if (depth >= SIGNAL_DEPTH_CAP) {
    apiLogger.warn('emitFlowSignal: depth cap reached, dropping signal', {
      organizationId: params.organizationId,
      signal: params.signal,
      depth,
    })
    return { matched: 0 }
  }

  const flows = await prisma.flow.findMany({
    where: { organizationId: params.organizationId, status: 'ACTIVE' },
    take: MAX_FLOWS_PER_EMIT,
  })

  const matches = flows.filter(
    (flow) => flow.id !== params.sourceFlowId && flowListensTo(flow, params.signal),
  )
  const failures: string[] = []

  for (const flow of matches) {
    try {
      // Trigger-level filter: skip flows whose condition doesn't match this
      // payload before doing any further work (no owner lookup, no run row).
      if (!triggerConditionPasses(flow.trigger, params.payload)) continue
      // Attribute the run to the flow owner when set; otherwise the org's
      // oldest active member (shared/ownerless flows have no single owner) —
      // mirrors the cron dispatcher's owner-attribution lookup.
      const owner = flow.userId
        ? await prisma.user.findFirst({
            where: { id: flow.userId, organizationId: flow.organizationId, isActive: true },
          })
        : await prisma.user.findFirst({
            where: { organizationId: flow.organizationId, isActive: true },
            orderBy: { createdAt: 'asc' },
          })
      if (!owner) {
        apiLogger.warn('emitFlowSignal: no active user to attribute the run to, skipping flow', {
          flowId: flow.id,
          organizationId: params.organizationId,
          signal: params.signal,
        })
        failures.push(`${flow.id}: no active owner`)
        continue
      }
      await dispatchFlowExecution({
        flowId: flow.id,
        organizationId: params.organizationId,
        userId: owner.id,
        input: params.payload,
        usePublished: true,
        trigger: { type: 'signal', signal: params.signal, depth },
        deliveryId: params.deliveryId ? `${params.deliveryId}-${flow.id}` : undefined,
      })
    } catch (error) {
      apiLogger.warn('emitFlowSignal: flow run failed, continuing with other matches', {
        flowId: flow.id,
        organizationId: params.organizationId,
        signal: params.signal,
        error: error instanceof Error ? error.message : String(error),
      })
      failures.push(`${flow.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (params.strictDelivery && failures.length) {
    throw new Error(`Signal handoff failed for ${failures.length} flow(s): ${failures.join('; ').slice(0, 250)}`)
  }

  return { matched: matches.length }
}
