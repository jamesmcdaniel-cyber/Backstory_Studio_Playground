import { generateStructured } from '@/lib/llm/model-runner'
import { AI_OP_LABELS, DATA_OPS, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { stepLabelsOf } from '@/lib/flows/token-text'
import {
  flowTemplateNotesSchema,
  isExecutableNode,
  type FlowTemplateBinding,
  type FlowTemplateNotes,
} from '@/lib/flows/templates/types'

/**
 * Drafting the notes for "Save as template" — the model reads the graph and
 * writes the explanation a reader needs; the user edits before saving.
 *
 * The output is schema-validated and then REPAIRED rather than trusted: a
 * missing step note or a stray `{{token}}` would violate the catalogue's
 * contract, and the POST route rejects those, so fixing them here is what keeps
 * the save from bouncing back at the user for the model's mistake.
 */

const NOTES_JSON_SCHEMA = {
  type: 'object',
  properties: {
    notesJson: {
      type: 'string',
      description:
        'The complete notes object as a JSON string: {"objective":"...","inputs":[...],"steps":[{"nodeId":"...","title":"...","what":"...","why":"..."}],"decisionRules":"...","failureHandling":"...","setup":[{"label":"...","kind":"integration|agent|value","ref":"..."}],"customize":["..."],"testPlan":"..."}',
    },
  },
  required: ['notesJson'],
  additionalProperties: false,
}

const SYSTEM = [
  'You document workflow automations for the people who will run them.',
  'You are given a flow graph. Return ONE JSON object with a single property, notesJson: a JSON string holding the notes object.',
  'Write for a competent colleague who did not build this flow. Be concrete and specific to THIS graph — never generic filler.',
  'objective: what the flow achieves AND how the reader knows it worked.',
  'steps: exactly one entry per executable step, using the EXACT nodeId given. `what` says what the step does in one sentence. `why` is optional and only worth writing when the configuration is non-obvious — a retry policy, an error tolerance, a threshold, a merge mode.',
  'decisionRules: the thresholds and branch conditions in plain English. failureHandling: retries, partial-failure behaviour, what happens when something is unreachable.',
  'setup: the ordered list of things a person must do before the flow can run — connect an integration, pick an agent, set a value. kind is integration, agent, or value.',
  'CRITICAL: never write template token syntax (double curly braces) in any string. Refer to earlier steps by their title instead, e.g. "the accounts from Pull open accounts".',
  'Do not invent capabilities the graph does not have. If a step is a passthrough placeholder, say so.',
].join(' ')

/** A compact, model-readable rendering of the graph — labels, types, and the config that matters. */
export function describeGraphForNotes(graph: FlowGraph): string {
  const labels = stepLabelsOf(graph)
  const lines: string[] = []
  const trigger = graph.nodes.find((node) => node.type === 'trigger')
  if (trigger?.type === 'trigger') lines.push(`Trigger: ${JSON.stringify(trigger.data.trigger ?? { type: 'manual' })}`)
  for (const node of graph.nodes) {
    if (!isExecutableNode(node)) continue
    lines.push(`- nodeId "${node.id}" · ${describeNodeType(node)} · titled "${labels[node.id] ?? node.id}"\n  config: ${JSON.stringify(node.data)}`)
  }
  lines.push(`Connections: ${graph.edges.map((edge) => `${edge.source}->${edge.target}${edge.branch ? ` [${edge.branch}]` : ''}`).join(', ')}`)
  return lines.join('\n')
}

function describeNodeType(node: FlowNode): string {
  if (node.type === 'ai') return `AI step (${AI_OP_LABELS[node.data.aiOp]})`
  if (node.type === 'data' && (DATA_OPS as readonly string[]).includes(node.data.op)) return `Data operation (${DATA_OP_LABELS[node.data.op]})`
  if (node.type === 'humanReview') return 'Request information from a person'
  if (node.type === 'code') return `Code (${node.data.language})`
  return node.type
}

function parseNotesReply(raw: string): unknown {
  const outer = JSON.parse(raw)
  const notesJson = outer && typeof outer === 'object' && !Array.isArray(outer) ? (outer as Record<string, unknown>).notesJson : undefined
  if (typeof notesJson !== 'string') return outer
  const trimmed = notesJson.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return JSON.parse(fenced ? fenced[1].trim() : trimmed)
}

/** Strip token syntax the model was told not to write, replacing it with the step's title. */
function detokenize(value: string, labels: Record<string, string>): string {
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, path: string) => {
    const parts = String(path).split('.')
    if (parts[0] === 'step' && parts[1]) return labels[parts[1]] ?? parts[1]
    if (parts[0] === 'trigger' && parts[1] === 'input') return parts[2] ? `the ${parts[2]} input` : 'the run input'
    if (parts[0] === 'var' && parts[1]) return `the ${parts[1]} variable`
    if (parts[0] === 'item') return 'the current item'
    return 'the earlier result'
  })
}

/**
 * Bring a drafted notes object up to the catalogue contract: one step entry per
 * executable node, in graph order, and no token syntax anywhere.
 */
export function repairDraftedNotes(notes: FlowTemplateNotes, graph: FlowGraph): FlowTemplateNotes {
  const labels = stepLabelsOf(graph)
  const byNode = new Map(notes.steps.map((step) => [step.nodeId, step]))
  const steps = graph.nodes.filter(isExecutableNode).map((node) => {
    const drafted = byNode.get(node.id)
    return {
      nodeId: node.id,
      title: drafted?.title?.trim() || labels[node.id] || node.id,
      what: drafted?.what?.trim() || `Runs the ${labels[node.id] || node.id} step.`,
      ...(drafted?.why?.trim() ? { why: detokenize(drafted.why, labels) } : {}),
    }
  })
  const clean = (value: string) => detokenize(value, labels)
  return {
    ...notes,
    objective: clean(notes.objective),
    inputs: notes.inputs.map((input) => ({ ...input, description: clean(input.description) })),
    steps: steps.map((step) => ({ ...step, what: clean(step.what) })),
    ...(notes.decisionRules ? { decisionRules: clean(notes.decisionRules) } : {}),
    ...(notes.failureHandling ? { failureHandling: clean(notes.failureHandling) } : {}),
    setup: notes.setup.map((step) => ({ ...step, label: clean(step.label) })),
    customize: notes.customize.map(clean),
    ...(notes.testPlan ? { testPlan: clean(notes.testPlan) } : {}),
  }
}

export interface DraftedNotes {
  notes: FlowTemplateNotes
  bindings: FlowTemplateBinding[]
  /** Prompts + model output, for the caller's usage metering. */
  rawParts: string[]
}

/**
 * Bindings inferred from the graph: every agent or tool step whose slot is
 * filled becomes a binding hint, so a template saved from a working flow stays
 * portable to a workspace that has a different agent or connection.
 */
export function inferBindings(graph: FlowGraph, agents: { id: string; name: string }[] = []): FlowTemplateBinding[] {
  const labels = stepLabelsOf(graph)
  const bindings: FlowTemplateBinding[] = []
  for (const node of graph.nodes) {
    if (node.type === 'agent' && node.data.agentId) {
      const agentName = agents.find((agent) => agent.id === node.data.agentId)?.name
      bindings.push({
        nodeId: node.id,
        kind: 'agent',
        label: `Pick the agent for ${labels[node.id] ?? node.id}`,
        match: agentName ? { agentName } : {},
      })
    }
    if (node.type === 'tool' && node.data.connectionId) {
      bindings.push({
        nodeId: node.id,
        kind: 'connection',
        label: `Pick the connection for ${labels[node.id] ?? node.id}`,
        match: { provider: node.data.connectionId, toolName: node.data.toolName },
      })
    }
  }
  return bindings
}

export async function draftFlowTemplateNotes(
  graph: FlowGraph,
  context: { name: string; description?: string; agents?: { id: string; name: string }[] },
): Promise<DraftedNotes> {
  const user = [
    `Flow name: ${context.name}`,
    context.description ? `Flow description: ${context.description}` : '',
    '',
    'Graph:',
    describeGraphForNotes(graph),
  ]
    .filter(Boolean)
    .join('\n')

  const raw = await generateStructured({ system: SYSTEM, user, schema: NOTES_JSON_SCHEMA, schemaName: 'flow_template_notes', maxTokens: 3000 })
  const notes = repairDraftedNotes(flowTemplateNotesSchema.parse(parseNotesReply(raw)), graph)
  return { notes, bindings: inferBindings(graph, context.agents), rawParts: [SYSTEM, user, raw] }
}
