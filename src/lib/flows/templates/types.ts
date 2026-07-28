import { z } from 'zod'
import { flowGraphSchema, type FlowGraph } from '@/lib/flows/graph'

/**
 * Flow templates: a reusable, WIRED flow.
 *
 * An agent template's payload is one prose blob the model reads at run time. A
 * flow template's payload is a validated graph — typed nodes with real
 * configuration (per-item fan-out, pagination, retry envelopes, branch
 * conditions, code bodies). None of that is expressible as prose the runtime
 * reads, so "instructions" here means something structurally different: the
 * graph is the executable artifact, and the notes are the explanation ANCHORED
 * to it, both per-node (`data.note`, which survives instantiation into the
 * user's flow) and per-template (`FlowTemplateNotes`, below).
 */

// One definition of "a step", shared with the flows list and the editor — see
// graph.ts. Re-exported here because the notes contract is expressed in terms
// of it (every executable node needs an explanation).
import { isExecutableNode } from '@/lib/flows/graph'
export { NON_EXECUTABLE_NODE_TYPES, isExecutableNode, stepCountOf } from '@/lib/flows/graph'

export const flowTemplateInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  example: z.string().optional(),
})

export const flowTemplateStepNoteSchema = z.object({
  /** Must match a node id in the template's graph. */
  nodeId: z.string().min(1),
  title: z.string().min(1),
  /** What this step does, in plain English. */
  what: z.string().min(1),
  /** Why it's built this way — the non-obvious part. */
  why: z.string().optional(),
})

export const flowTemplateSetupStepSchema = z.object({
  label: z.string().min(1),
  kind: z.enum(['integration', 'agent', 'value']),
  /** Provider key / agent name / node id the item refers to, when it has one. */
  ref: z.string().optional(),
})

export const flowTemplateNotesSchema = z.object({
  /** What this pipeline achieves, and how you know it worked. */
  objective: z.string().min(1),
  /** What you supply at run time. */
  inputs: z.array(flowTemplateInputSchema).default([]),
  /** One entry per executable node, keyed to a real graph node id. */
  steps: z.array(flowTemplateStepNoteSchema).default([]),
  /** Thresholds and branch logic in plain English. */
  decisionRules: z.string().optional(),
  /** Retries, partial failure, deduplication, idempotency. */
  failureHandling: z.string().optional(),
  /** Ordered "before this runs" checklist. */
  setup: z.array(flowTemplateSetupStepSchema).default([]),
  /** The knobs worth tuning for your workspace. */
  customize: z.array(z.string()).default([]),
  /** How to verify it before switching the trigger on. */
  testPlan: z.string().optional(),
})
export type FlowTemplateNotes = z.infer<typeof flowTemplateNotesSchema>

/**
 * How to fill a graph slot the template ships empty. `agentNode.data.agentId`
 * and `toolNode.data.connectionId` are required strings in the graph schema, so
 * a portable template ships them as '' and declares the intent here. Binding
 * hints live at the TEMPLATE level, not in `data` — zod strips unknown keys
 * from node data, so the graph stays schema-pure.
 */
export const flowTemplateBindingSchema = z.object({
  nodeId: z.string().min(1),
  kind: z.enum(['agent', 'connection']),
  /** Plain-English "what goes here", shown in the setup checklist. */
  label: z.string().min(1),
  match: z
    .object({
      /** Agent name to look for in the workspace roster (case-insensitive). */
      agentName: z.string().optional(),
      /** Connection id or provider key ('nango:salesforce', 'native:slack', …). */
      provider: z.string().optional(),
      /** Tool the node calls — narrows a provider match to a connection that has it. */
      toolName: z.string().optional(),
    })
    .default({}),
})
export type FlowTemplateBinding = z.infer<typeof flowTemplateBindingSchema>

/** Catalogue metadata stored in a row's `configuration` blob. */
export const flowTemplateConfigSchema = z.object({
  integrations: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  icon: z.string().default(''),
  exampleOutput: z.string().default(''),
  authorName: z.string().default(''),
})
export type FlowTemplateConfig = z.infer<typeof flowTemplateConfigSchema>

/** A built-in template as authored in `src/lib/flows/templates/builtin`. */
export interface FlowTemplateDef {
  id: string
  name: string
  description: string
  category: string
  graph: FlowGraph
  notes: FlowTemplateNotes
  bindings: FlowTemplateBinding[]
  integrations: string[]
  tags: string[]
  icon: string
  exampleOutput?: string
}

/** The API shape both built-ins and stored rows serialize to. */
export interface SerializedFlowTemplate {
  id: string
  name: string
  description: string
  category: string
  graph: FlowGraph
  trigger: unknown
  notes: FlowTemplateNotes
  bindings: FlowTemplateBinding[]
  integrations: string[]
  tags: string[]
  icon: string
  exampleOutput: string
  authorName: string
  stepCount: number
  /** false for built-ins — they have no row to edit or delete. */
  custom: boolean
  source: string
  visibility: string
  /** Only the creating org may edit/delete. */
  mine: boolean
}

/**
 * Raw `{{token}}` syntax must never reach the UI (a standing product rule) —
 * graphs use it internally, but notes are prose a person reads, so they refer
 * to earlier steps by title instead.
 */
export function containsRawToken(value: string): boolean {
  return value.includes('{{')
}

/** Every user-facing string in a notes object, for the raw-token check. */
export function notesStrings(notes: FlowTemplateNotes): string[] {
  return [
    notes.objective,
    ...notes.inputs.flatMap((input) => [input.name, input.description, input.example ?? '']),
    ...notes.steps.flatMap((step) => [step.title, step.what, step.why ?? '']),
    notes.decisionRules ?? '',
    notes.failureHandling ?? '',
    ...notes.setup.map((step) => step.label),
    ...notes.customize,
    notes.testPlan ?? '',
  ]
}

/**
 * The notes-to-graph contract, as a list of human-readable problems (empty =
 * fine). Enforced by test over the built-in catalogue and by the API when a
 * user saves a flow as a template.
 */
export function flowTemplateNotesIssues(graph: FlowGraph, notes: FlowTemplateNotes, bindings: FlowTemplateBinding[] = []): string[] {
  const issues: string[] = []
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  const noted = new Set(notes.steps.map((step) => step.nodeId))

  for (const step of notes.steps) {
    if (!nodeIds.has(step.nodeId)) issues.push(`Notes describe a step "${step.title}" that is not in the flow.`)
  }
  for (const node of graph.nodes) {
    if (!isExecutableNode(node)) continue
    if (!noted.has(node.id)) issues.push(`Step "${node.id}" has no explanation in the notes.`)
    const note = 'note' in node.data ? node.data.note : undefined
    if (typeof note !== 'string' || !note.trim()) issues.push(`Step "${node.id}" is missing its on-canvas note.`)
  }
  for (const binding of bindings) {
    if (!nodeIds.has(binding.nodeId)) issues.push(`Setup item "${binding.label}" points at a step that is not in the flow.`)
  }
  for (const value of notesStrings(notes)) {
    if (containsRawToken(value)) {
      issues.push('Notes must be plain English — refer to earlier steps by name rather than with token syntax.')
      break
    }
  }
  return issues
}

/** Parse an untrusted stored/authored template payload. Throws on a bad graph. */
export function parseFlowTemplateGraph(value: unknown): FlowGraph {
  return flowGraphSchema.parse(value)
}
