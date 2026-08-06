import { AI_OP_LABELS, VARIABLE_OP_LABELS, type FlowGraph, type FlowNode } from '@/lib/flows/graph'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'

/**
 * Pure presentation helpers that turn `{{token}}` template strings into
 * plain-English segments and labels. Storage format is unchanged — these
 * only affect how tokens are displayed and edited.
 */

export type TokenSegment = { kind: 'text', value: string } | { kind: 'token', path: string }
export type TokenLabelContext = { stepLabels: Record<string, string> }

const TOKEN_RE = /\{\{\s*([^{}]+?)\s*\}\}/g

/**
 * Split a template string into literal-text and token segments. Token paths
 * are trimmed of inner padding, so `{{ x }}` parses to path `x` — serializing
 * back emits the canonical `{{x}}`.
 */
export function parseTokenSegments(value: string): TokenSegment[] {
  const segments: TokenSegment[] = []
  let last = 0
  for (const match of value.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0
    if (index > last) segments.push({ kind: 'text', value: value.slice(last, index) })
    segments.push({ kind: 'token', path: match[1] })
    last = index + match[0].length
  }
  if (last < value.length) segments.push({ kind: 'text', value: value.slice(last) })
  return segments
}

/**
 * Re-assemble segments into a template string. Tokens re-emit as `{{path}}`
 * with no padding, so `{{ x }}` normalizes to `{{x}}`; canonical inputs
 * round-trip exactly.
 */
export function serializeTokenSegments(segments: TokenSegment[]): string {
  return segments.map((s) => (s.kind === 'token' ? `{{${s.path}}}` : s.value)).join('')
}

/** Render a field path part: numeric segments read as 1-based item positions. */
function fieldPart(part: string): string {
  return /^\d+$/.test(part) ? `item ${Number(part) + 1}` : part
}

function joinParts(root: string, rest: string[]): string {
  return [root, ...rest.map(fieldPart)].join(' › ')
}

/**
 * Fixed labels for the run-context tokens: the frozen clock (`{{now}}`) and the
 * run/flow metadata (`{{run.*}}`/`{{flow.*}}`). Whole-path lookups — these have
 * no user-authored parts to humanize.
 */
const CONTEXT_TOKEN_LABELS: Record<string, string> = {
  now: 'Current time',
  'now.date': "Today's date",
  'now.time': 'Current time of day',
  'now.unix': 'Timestamp',
  'run.id': 'This run › id',
  'run.startedAt': 'This run › started',
  'run.trigger': 'This run › trigger',
  'run.url': 'This run › link',
  'flow.id': 'This flow › id',
  'flow.name': 'This flow › name',
}

/** Map a token path (no braces) to a plain-English label. */
export function friendlyTokenLabel(path: string, ctx: TokenLabelContext): string {
  if (CONTEXT_TOKEN_LABELS[path]) return CONTEXT_TOKEN_LABELS[path]
  const parts = path.split('.')
  if (parts[0] === 'input') return joinParts('Incoming data', parts.slice(1))
  if (parts[0] === 'trigger' && parts[1] === 'input') return joinParts('Run input', parts.slice(2))
  if (parts[0] === 'step' && parts[1] && parts[2] === 'output') {
    const stepLabel = ctx.stepLabels[parts[1]] || `Step ${parts[1]}`
    return joinParts(stepLabel, parts.slice(3))
  }
  if (parts[0] === 'steps') return joinParts('All earlier data', parts.slice(1))
  if (parts[0] === 'item') return joinParts('Current item', parts.slice(1))
  if (parts[0] === 'var' && parts[1]) return joinParts('Variable', parts.slice(1))
  if (path === 'loop.index') return 'Item number'
  return path
}

/** Replace every `{{token}}` with its friendly label (plain text, no braces). */
export function humanizeTokens(value: string, ctx: TokenLabelContext): string {
  return parseTokenSegments(value)
    .map((s) => (s.kind === 'token' ? friendlyTokenLabel(s.path, ctx) : s.value))
    .join('')
}

/**
 * Plain-English fallback label for a step with no user label. Variable/data
 * steps read as their operation and human review as 'Request information' —
 * internal type names like "humanReview" must never reach the user.
 */
export function defaultStepLabel(node: FlowNode): string {
  if (node.type === 'variable') return VARIABLE_OP_LABELS[node.data.op]
  if (node.type === 'data') return DATA_OP_LABELS[node.data.op]
  if (node.type === 'ai') return AI_OP_LABELS[node.data.aiOp]
  if (node.type === 'subflow') return 'Run a flow'
  if (node.type === 'knowledge') return 'Search knowledge'
  if (node.type === 'code') return node.data.language === 'python' ? 'Python' : 'JavaScript'
  if (node.type === 'humanReview') return 'Request information'
  return node.type.charAt(0).toUpperCase() + node.type.slice(1)
}

/**
 * Node-id → display-label map matching the builder's `labelForNode`: agent
 * nodes use their label, else the agent's title, else 'Agent step'; other
 * nodes use their label, else a plain-English type label. The trigger is excluded.
 */
export function stepLabelsOf(graph: FlowGraph, agents?: { id: string, title: string }[]): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const node of graph.nodes) {
    if (node.type === 'trigger') continue
    if (node.type === 'agent') {
      labels[node.id] = node.data.label || agents?.find((a) => a.id === node.data.agentId)?.title || 'Agent step'
    } else {
      const label = 'label' in node.data ? node.data.label : undefined
      labels[node.id] = label || defaultStepLabel(node)
    }
  }
  return labels
}
