import { FIELD_TYPES, type FlowGraph, type TriggerInputField } from '@/lib/flows/graph'

export const FLOW_TRIGGER_TYPES = ['manual', 'schedule', 'webhook', 'signal', 'poll'] as const
export type FlowTriggerType = (typeof FLOW_TRIGGER_TYPES)[number]
export type FlowTrigger = { type: FlowTriggerType; [key: string]: unknown }

// Signals a flow's trigger can listen for (a signal-type trigger fires when a
// flow or agent completes — or fails — elsewhere in the org). Client-safe — no
// prisma — so the builder UI can import this list directly. `flow.failed` lets
// a flow act as an org-level error handler (n8n's "Error Workflow" without a
// new concept): publish a flow that listens for flow.failed and it runs
// whenever any other published flow in the org fails, with the failing flow's
// id/name/error as its input.
export const KNOWN_SIGNALS = ['flow.completed', 'flow.failed', 'agent.completed'] as const
export type KnownSignal = (typeof KNOWN_SIGNALS)[number]

/** Plain-english descriptions for the signal picker — no raw event names shown. */
export const KNOWN_SIGNAL_LABELS: Record<KnownSignal, string> = {
  'flow.completed': 'When any flow finishes successfully',
  'flow.failed': 'When any flow fails (build an error handler)',
  'agent.completed': 'When any agent finishes',
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
 * dispatchers read Flow.trigger, so every save/publish must sync this value.
 */
export function triggerFromGraph(graph: FlowGraph, fallback?: unknown): FlowTrigger {
  const node = graph.nodes.find((candidate) => candidate.type === 'trigger')
  const trigger = node?.type === 'trigger' ? node.data.trigger : undefined
  return normalizeFlowTrigger(trigger, fallback)
}

export function preserveWebhookSecretHash(next: unknown, existing: unknown): FlowTrigger {
  const trigger = normalizeFlowTrigger(next)
  if (isRecord(existing) && typeof existing.webhookSecretHash === 'string') {
    trigger.webhookSecretHash = existing.webhookSecretHash
  }
  return trigger
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
