import { Prisma } from '@prisma/client'
import type { FlowGraph } from '@/lib/flows/graph'
import {
  activityMatchColumns,
  anchorTriggerSchedule,
  pollIdentityChanged,
  preserveWebhookSecretHash,
  triggerFromGraph,
  type FlowTrigger,
} from '@/lib/flows/trigger'

/**
 * Which trigger the Flow row's trigger columns hold, and who may write them.
 *
 * Every firing path — the scheduler and poller, the webhook route, hosted
 * forms, signals, the activity dispatcher — reads `Flow.trigger` (and its
 * denormalized `activitySource`/`activityKinds`), and every one of them runs
 * `publishedGraph`. So while a flow is published those columns must describe
 * the PUBLISHED trigger, and only publishing (or reverting to it) may change
 * them. A draft autosave that rewrote them re-armed the live flow on whatever
 * the author was experimenting with: flipping a published webhook flow's draft
 * to a schedule made production webhooks 409 and started the scheduler running
 * the published graph on the draft's cadence, with none of publish's checks.
 *
 * While nothing is published the columns follow the draft, exactly as before:
 * there is no live trigger to protect, and publish validation reads the
 * webhook secret from them.
 *
 * Two values survive every rewrite: the webhook secret hash (the client never
 * holds it, so a derived trigger never carries it) and an unchanged schedule's
 * anchor. And whenever the poll that will fire changes identity, its cursor is
 * dropped so the next poll baselines instead of treating every record as new.
 */

type StoredTriggerState = {
  trigger: unknown
  publishedGraph: unknown
}

export type TriggerColumns = {
  trigger: Prisma.InputJsonValue
  activitySource: string | null
  activityKinds: string[]
  pollCursor?: typeof Prisma.DbNull
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null))
}

function columnsFor(next: FlowTrigger, resetPollCursor: boolean): TriggerColumns {
  return {
    trigger: jsonValue(next),
    ...activityMatchColumns(next),
    ...(resetPollCursor ? { pollCursor: Prisma.DbNull } : {}),
  }
}

/**
 * Trigger columns for a DRAFT write (builder autosave, MCP update_flow, the
 * public API PUT, a version restore) whose draft trigger is now `next`.
 * Returns null when the flow is published: the columns hold the live trigger
 * and the draft's trigger takes effect only when it is published.
 */
export function draftTriggerColumns(next: FlowTrigger, existing: StoredTriggerState): TriggerColumns | null {
  if (existing.publishedGraph != null) return null
  const trigger = anchorTriggerSchedule(preserveWebhookSecretHash(next, existing.trigger), existing.trigger)
  return columnsFor(trigger, pollIdentityChanged(existing.trigger, trigger))
}

/** draftTriggerColumns for a write that carries a graph: the trigger is the graph's. */
export function draftGraphTriggerColumns(graph: FlowGraph, existing: StoredTriggerState): TriggerColumns | null {
  return draftTriggerColumns(triggerFromGraph(graph, existing.trigger), existing)
}

/**
 * Trigger columns for making `publishedGraph` the live graph — at publish, and
 * on revert (where it re-states the published trigger, which also heals a row
 * whose columns were last written by a draft save before this rule existed).
 *
 * A flow being armed from unpublished gets a fresh schedule anchor (it fires on
 * its next real occurrence, never a catch-up) and a fresh poll baseline (items
 * that appeared while it was off are not a backlog to replay — the same rule a
 * brand-new poll follows). A republish keeps both unless what fires changed.
 */
export function publishedTriggerColumns(
  publishedGraph: FlowGraph,
  existing: StoredTriggerState,
): { trigger: FlowTrigger; columns: TriggerColumns } {
  const arming = existing.publishedGraph == null
  const trigger = anchorTriggerSchedule(
    preserveWebhookSecretHash(triggerFromGraph(publishedGraph, existing.trigger), existing.trigger),
    arming ? null : existing.trigger,
  )
  return { trigger, columns: columnsFor(trigger, arming || pollIdentityChanged(existing.trigger, trigger)) }
}
