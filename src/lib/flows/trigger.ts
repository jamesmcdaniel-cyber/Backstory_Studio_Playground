import { FIELD_TYPES, type FlowGraph, type TriggerInputField } from '@/lib/flows/graph'
import { anchorSchedule } from '@/lib/scheduling/due'

// 'activity' and 'slack' are the two event-trigger types (activity-event
// substrate): 'activity' fires from a normalized ActivityEvent (Nango
// ingestion — provider webhooks/polling across connected apps), 'slack'
// fires from the workspace's own Slack Events API receiver. Their config
// shapes:
//   { type: 'activity', source, kinds: string[], filters?: { channelId?, actorExternalId? } }
//   { type: 'slack', channelId?, threadOnly?: boolean }
// Both are configurable by anyone but ARM (are reachable at publish/run
// time) only for workspaces above free tier or internal/partner — see
// validateTriggerConfig in validate.ts and canArmEventTriggers in
// free-tier-limits.ts.
export const FLOW_TRIGGER_TYPES = ['manual', 'schedule', 'webhook', 'form', 'signal', 'poll', 'activity', 'slack'] as const
export type FlowTriggerType = (typeof FLOW_TRIGGER_TYPES)[number]
export type FlowTrigger = { type: FlowTriggerType; [key: string]: unknown }

/** Plain-English labels for the two event-trigger types — no raw event codes
 *  or provider jargon shown to the user (per the no-raw-token mandate). */
export const EVENT_TRIGGER_LABELS = {
  slack: 'When someone posts in Slack',
  activity: 'When something happens in a connected app',
} as const satisfies Record<'slack' | 'activity', string>

// Signals a flow's trigger can listen for (a signal-type trigger fires when a
// flow or agent completes — or fails — elsewhere in the org). Client-safe — no
// prisma — so the builder UI can import this list directly. `flow.failed` lets
// a flow act as an org-level error handler (n8n's "Error Workflow" without a
// new concept): publish a flow that listens for flow.failed and it runs
// whenever any other published flow in the org fails, with the failing flow's
// id/name/error as its input.
export const KNOWN_SIGNALS = ['flow.completed', 'flow.failed', 'agent.completed', 'agent.blocked'] as const
export type KnownSignal = (typeof KNOWN_SIGNALS)[number]

/** Plain-english descriptions for the signal picker — no raw event names shown. */
export const KNOWN_SIGNAL_LABELS: Record<KnownSignal, string> = {
  'flow.completed': 'When any flow finishes successfully',
  'flow.failed': 'When any flow fails (build an error handler)',
  'agent.completed': 'When any agent finishes',
  // Its own signal, deliberately NOT folded into agent.completed: a blocked run
  // did its work but could not deliver it, so a flow chained off "finished"
  // must not treat it as though the delivery happened.
  'agent.blocked': 'When an agent finishes but cannot deliver (integration not connected)',
}

/**
 * Plain-English labels for the activity trigger's event-type chips — no raw
 * verb codes shown to the user (per the no-raw-token mandate).
 *
 * This is a LITERAL COPY of the kind vocabulary in `ACTIVITY_KINDS`
 * (src/lib/activity/normalize.ts), not an import: that module pulls in
 * `node:crypto` for its content-hash fallback, which has no business in a
 * client bundle, and this file (trigger.ts) is imported directly by
 * client-side builder components (trigger-editor.tsx, builtin-catalog.ts).
 * Keep this list in sync with normalize.ts's `ACTIVITY_KINDS` by hand — a
 * kind that exists there and is missing here would render as a raw code
 * instead of a label, which `ACTIVITY_KIND_LABELS`'s callers must never do.
 */
export const ACTIVITY_KINDS_CLIENT = [
  'message.posted',
  'agent.mentioned',
  'record.created',
  'record.updated',
  'record.deleted',
  'pr.opened',
  'pr.closed',
  'pr.merged',
  'issue.opened',
  'issue.closed',
  'push',
  'generic',
] as const

export type ActivityKindClient = (typeof ACTIVITY_KINDS_CLIENT)[number]

export const ACTIVITY_KIND_LABELS: Record<ActivityKindClient, string> = {
  'message.posted': 'New message posted',
  'agent.mentioned': 'Someone mentioned an agent',
  'record.created': 'Record created',
  'record.updated': 'Record updated',
  'record.deleted': 'Record deleted',
  'pr.opened': 'Pull request opened',
  'pr.closed': 'Pull request closed',
  'pr.merged': 'Pull request merged',
  'issue.opened': 'Issue opened',
  'issue.closed': 'Issue closed',
  push: 'Code pushed',
  generic: 'Other activity',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function validTriggerType(value: unknown): value is FlowTriggerType {
  return typeof value === 'string' && (FLOW_TRIGGER_TYPES as readonly string[]).includes(value)
}

export function normalizeFlowTrigger(value: unknown, fallback?: unknown): FlowTrigger {
  const input = isRecord(value) ? value : undefined
  const base = input ?? (isRecord(fallback) ? fallback : {})
  const type = validTriggerType(base.type) ? base.type : 'manual'
  return { ...base, type }
}

/**
 * The builder stores the editable trigger on the graph's trigger node. Runtime
 * dispatchers read Flow.trigger, which holds the trigger of the graph that
 * RUNS: synced from the draft only while nothing is published, and from the
 * published graph at publish — see src/lib/flows/trigger-columns.ts.
 */
export function triggerFromGraph(graph: FlowGraph, fallback?: unknown): FlowTrigger {
  const node = graph.nodes.find((candidate) => candidate.type === 'trigger')
  const trigger = node?.type === 'trigger' ? node.data.trigger : undefined
  return normalizeFlowTrigger(trigger, fallback)
}

/**
 * Maintains trigger.schedule's anchor across saves (see anchorSchedule): a new
 * or changed schedule is anchored at now so it fires on its next real
 * occurrence instead of instantly catching up; an unchanged one keeps its
 * anchor. Pass `existing` = the stored trigger (or null to force a fresh
 * anchor, e.g. when publishing first arms the schedule).
 */
export function anchorTriggerSchedule(next: FlowTrigger, existing?: unknown): FlowTrigger {
  if (!isRecord(next.schedule)) return next
  const prev = isRecord(existing) && isRecord(existing.schedule) ? existing.schedule : null
  return { ...next, schedule: anchorSchedule(next.schedule as { type?: string; isActive?: boolean }, prev) }
}

export function preserveWebhookSecretHash(next: unknown, existing: unknown): FlowTrigger {
  const trigger = normalizeFlowTrigger(next)
  if (isRecord(existing) && typeof existing.webhookSecretHash === 'string') {
    trigger.webhookSecretHash = existing.webhookSecretHash
  }
  return trigger
}

/** JSON with object keys sorted, so two triggers that differ only in key order compare equal. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * What a poll trigger's cursor is a cursor OF: the read it calls and how it
 * picks out and keys items. The cursor's "seen" keys only mean anything for
 * this exact read — point the poll at another tool, connection, query, list
 * field or id field and every record it returns looks new. Null for any other
 * trigger type. Cadence and emit mode are deliberately absent: they change when
 * and how runs start, not which items count as seen.
 */
export function pollIdentity(trigger: unknown): string | null {
  if (!isRecord(trigger) || trigger.type !== 'poll') return null
  // args is stored as the editor's JSON text; parse it so whitespace or key
  // order alone is not a "different query".
  let args: unknown = trigger.args ?? null
  if (typeof args === 'string') {
    try {
      args = args.trim() ? JSON.parse(args) : null
    } catch {
      // Unparseable text is compared as text — still an identity.
    }
  }
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  return stableJson({
    connectionId: text(trigger.connectionId),
    toolName: text(trigger.toolName),
    args: isRecord(args) && Object.keys(args).length === 0 ? null : args,
    itemsPath: text(trigger.itemsPath),
    // The dispatcher keys on 'id' when none is set (poll-dispatch.ts).
    dedupeKey: text(trigger.dedupeKey) || 'id',
  })
}

/**
 * Whether the flow's stored poll cursor must be dropped when the trigger that
 * FIRES goes from `previous` to `next`. Any change to the poll's identity —
 * including switching away from a poll and back — means the cursor's seen keys
 * describe some other read, and reusing them starts one run per pre-existing
 * record. Dropping it makes the next poll a baseline again (emits nothing).
 */
export function pollIdentityChanged(previous: unknown, next: unknown): boolean {
  return pollIdentity(previous) !== pollIdentity(next)
}

/** Plain-English name of a trigger type, for "the live flow still starts …" notices. */
export function triggerTypeLabel(type: unknown): string {
  switch (type) {
    case 'schedule':
      return 'on a schedule'
    case 'poll':
      return 'when new items appear in an app'
    case 'webhook':
      return 'when an HTTP request is received'
    case 'form':
      return 'when its hosted form is submitted'
    case 'signal':
      return 'on a workspace signal'
    case 'slack':
      return 'when someone posts in Slack'
    case 'activity':
      return 'when something happens in a connected app'
    default:
      return 'only when someone runs it'
  }
}

/**
 * How the draft's trigger differs from the one the published flow fires on —
 * 'type' (a different kind of trigger), 'config' (same kind, different
 * settings), or null. Server-held fields are ignored: the secret hash never
 * reaches the client, and a schedule's anchor is bookkeeping, not a setting.
 */
export function triggerDraftDiff(live: unknown, draft: unknown): 'type' | 'config' | null {
  const comparable = (value: unknown) => {
    const trigger: Record<string, unknown> = { ...normalizeFlowTrigger(value) }
    delete trigger.webhookSecretHash
    if (isRecord(trigger.schedule)) {
      const schedule = { ...trigger.schedule }
      delete schedule.anchor
      trigger.schedule = schedule
    }
    return trigger
  }
  const a = comparable(live)
  const b = comparable(draft)
  if (a.type !== b.type) return 'type'
  return stableJson(a) === stableJson(b) ? null : 'config'
}

/**
 * The denormalized match columns (`Flow.activitySource`/`Flow.activityKinds`)
 * for a trigger, kept in lockstep with `Flow.trigger` at every write site that
 * calls `triggerFromGraph` — see the columns' doc comments in schema.prisma.
 * An 'activity' trigger writes its configured source + kinds; a 'slack'
 * trigger is sugar over the same matcher, so it always writes activitySource
 * 'slack' + kinds ['message.posted'] regardless of its own config (channelId/
 * threadOnly are per-event filters applied by the dispatcher, not part of the
 * match index). Every other trigger type clears both back to null/[] — a flow
 * whose trigger changed away from an event type must stop matching.
 */
export function activityMatchColumns(trigger: FlowTrigger): { activitySource: string | null; activityKinds: string[] } {
  if (trigger.type === 'activity') {
    const source = typeof trigger.source === 'string' && trigger.source.trim() ? trigger.source.trim() : null
    const kinds = Array.isArray(trigger.kinds)
      ? trigger.kinds.filter((kind): kind is string => typeof kind === 'string' && kind.trim() !== '')
      : []
    return { activitySource: source, activityKinds: kinds }
  }
  if (trigger.type === 'slack') {
    return { activitySource: 'slack', activityKinds: ['message.posted'] }
  }
  return { activitySource: null, activityKinds: [] }
}

/** Normalize the trigger's declared input fields from untrusted JSON. */
export function triggerInputFieldsFromTrigger(trigger: unknown): TriggerInputField[] {
  if (!isRecord(trigger) || !Array.isArray(trigger.inputFields)) return []
  return trigger.inputFields.filter(isRecord).map((field) => ({
    name: typeof field.name === 'string' ? field.name : '',
    type: (FIELD_TYPES as readonly string[]).includes(String(field.type)) ? (field.type as TriggerInputField['type']) : 'any',
    description: typeof field.description === 'string' ? field.description : undefined,
    required: field.required === true,
    default: typeof field.default === 'string' && field.default !== '' ? field.default : undefined,
  }))
}
