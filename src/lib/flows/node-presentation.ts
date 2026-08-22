import {
  Bot,
  Braces,
  BookOpen,
  CircleStop,
  Code2,
  Filter,
  FileOutput,
  GitBranch,
  GitMerge,
  Globe,
  Repeat,
  Rows3,
  SlidersHorizontal,
  Sparkles,
  Split,
  StickyNote,
  Timer,
  UserCheck,
  Variable,
  Workflow,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import {
  AI_OP_LABELS,
  CONDITION_OP_LABELS,
  VARIABLE_OP_LABELS,
  VARIABLE_TYPE_LABELS,
  type FlowNode,
} from '@/lib/flows/graph'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { EVENT_TRIGGER_LABELS } from '@/lib/flows/trigger'
import { selectedToolPresentation, stepBrandFallback, type PresentableConnection } from '@/lib/flows/tool-presentation'
import { humanizeTokens, type TokenLabelContext } from '@/lib/flows/token-text'

/**
 * How a step is presented on ANY builder surface — the Inline chain, the Canvas
 * chip, the minimap, the step search. Single source of truth: two surfaces that
 * name the same step differently is a bug users read as two different steps.
 */

export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'waiting' | 'skipped' | 'stopped' | 'resumed' | 'cancelled'

export const NODE_ICON: Record<FlowNode['type'], LucideIcon> = {
  trigger: Zap,
  agent: Bot,
  condition: GitBranch,
  loop: Repeat,
  parallel: Rows3,
  stop: CircleStop,
  tool: Wrench,
  http: Globe,
  transform: SlidersHorizontal,
  filter: Filter,
  switch: Split,
  variable: Variable,
  data: Braces,
  humanReview: UserCheck,
  output: FileOutput,
  join: GitMerge,
  ai: Sparkles,
  subflow: Workflow,
  knowledge: BookOpen,
  code: Code2,
  wait: Timer,
  note: StickyNote,
}

export const NODE_TONE: Record<FlowNode['type'], string> = {
  trigger: 'bg-blue-600 text-white',
  agent: 'bg-slate-900 text-white',
  http: 'bg-emerald-600 text-white',
  tool: 'bg-orange-500 text-white',
  condition: 'bg-amber-500 text-white',
  loop: 'bg-sky-500 text-white',
  parallel: 'bg-cyan-600 text-white',
  stop: 'bg-red-500 text-white',
  transform: 'bg-violet-500 text-white',
  filter: 'bg-lime-600 text-white',
  switch: 'bg-fuchsia-600 text-white',
  variable: 'bg-purple-600 text-white',
  data: 'bg-violet-600 text-white',
  humanReview: 'bg-blue-600 text-white',
  output: 'bg-teal-600 text-white',
  join: 'bg-indigo-600 text-white',
  ai: 'bg-indigo-500 text-white',
  subflow: 'bg-teal-500 text-white',
  knowledge: 'bg-rose-500 text-white',
  code: 'bg-amber-600 text-white',
  wait: 'bg-slate-500 text-white',
  note: 'bg-yellow-400 text-yellow-950',
}

export const STATUS_DOT: Record<StepStatus, string> = {
  queued: 'bg-gray-300',
  running: 'bg-amber-400 animate-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  waiting: 'bg-blue-500 animate-pulse',
  skipped: 'bg-gray-300',
  stopped: 'bg-slate-500',
  resumed: 'bg-gray-300',
  cancelled: 'bg-slate-500',
}

/** Status → text color. The one map behind the run panel and activity views,
 *  so a status reads the same color everywhere it appears. */
export const STATUS_TEXT: Record<StepStatus, string> = {
  queued: 'text-fg-muted',
  running: 'text-amber-600',
  succeeded: 'text-emerald-600',
  failed: 'text-red-600',
  waiting: 'text-blue-600',
  skipped: 'text-fg-muted',
  stopped: 'text-slate-500',
  resumed: 'text-fg-muted',
  cancelled: 'text-slate-500',
}

/** Everything the label functions need that isn't on the node itself. */
export type PresentationContext = {
  /** Resolve an agent id to its title; '' when unknown. */
  agentName: (agentId: string) => string
  toolCatalog: PresentableConnection[]
  /** Drives the webhook trigger's "publish to arm" hint. */
  published?: boolean
}

export function titleFor(node: FlowNode, ctx: PresentationContext): string {
  switch (node.type) {
    case 'trigger': {
      const type = (node.data.trigger as { type?: string } | undefined)?.type ?? 'manual'
      if (type === 'schedule') return 'Schedule trigger'
      if (type === 'poll') return 'When new items appear'
      if (type === 'webhook') return 'When an HTTP request is received'
      if (type === 'signal') return 'Signal trigger'
      if (type === 'activity') return EVENT_TRIGGER_LABELS.activity
      if (type === 'slack') return EVENT_TRIGGER_LABELS.slack
      return 'Manually trigger a flow'
    }
    case 'agent':
      return node.data.label || ctx.agentName(node.data.agentId) || 'Run an agent'
    case 'condition': {
      const clause = node.data.clauses?.[0] ?? (node.data.left !== undefined ? { left: node.data.left, op: node.data.op, right: node.data.right } : null)
      const extra = (node.data.clauses?.length ?? 1) > 1 ? ` +${node.data.clauses!.length - 1}` : ''
      return node.data.label || (clause?.left ? `If ${clause.left} ${CONDITION_OP_LABELS[clause.op ?? 'eq']} ${clause.right}${extra}` : 'If / else')
    }
    case 'loop':
      return node.data.label || 'For each'
    case 'parallel':
      return node.data.label || 'Parallel branches'
    case 'stop':
      return node.data.label || 'Stop flow'
    case 'tool':
      return (
        node.data.label ||
        selectedToolPresentation(ctx.toolCatalog, node.data.connectionId, node.data.toolName).actionLabel ||
        'Run a connected tool'
      )
    case 'http':
      return node.data.label || 'HTTP request'
    case 'transform':
      return node.data.label || 'Set fields'
    case 'filter':
      return node.data.label || 'Filter'
    case 'switch':
      return node.data.label || 'Switch'
    case 'variable': {
      const name = node.data.name.trim()
      return node.data.label || `${VARIABLE_OP_LABELS[node.data.op]}${name ? ` ${name}` : ''}`
    }
    case 'data':
      return node.data.label || DATA_OP_LABELS[node.data.op]
    case 'humanReview':
      return node.data.label || 'Request information'
    case 'output':
      return node.data.label || 'Output'
    case 'join':
      return node.data.label || 'Join paths'
    case 'ai':
      return node.data.label || AI_OP_LABELS[node.data.aiOp]
    case 'subflow':
      return node.data.label || 'Run a flow'
    case 'knowledge':
      return node.data.label || 'Search knowledge'
    case 'code':
      return node.data.label || (node.data.language === 'python' ? 'Python' : 'JavaScript')
    case 'wait':
      return node.data.label || 'Wait'
    case 'note':
      return node.data.text.trim().split('\n')[0] || 'Note'
  }
}

export function subtitleFor(node: FlowNode, ctx: PresentationContext): string | undefined {
  switch (node.type) {
    case 'trigger': {
      const trigger = (node.data.trigger as
        | {
            type?: string
            schedule?: { type?: string; time?: string; timezone?: string }
            signal?: string
            inputFields?: unknown[]
            toolName?: string
            source?: string
            kinds?: string[]
            channelId?: string
            threadOnly?: boolean
          }
        | undefined) ?? {}
      const type = trigger.type ?? 'manual'
      const inputCount = (trigger.inputFields ?? []).length
      const inputLine = inputCount ? `${inputCount} input${inputCount === 1 ? '' : 's'}` : 'Add fields users fill in before the flow runs.'
      if (type === 'schedule') {
        const schedule = trigger.schedule ?? {}
        return `Runs ${schedule.type ?? 'daily'}${schedule.time ? ` at ${schedule.time}` : ''} (${schedule.timezone || 'UTC'})`
      }
      if (type === 'poll') return trigger.toolName ? `Checks ${trigger.toolName} ${trigger.schedule?.type ?? 'hourly'}` : 'Pick an app and read action to poll'
      if (type === 'signal') return `Listens for "${trigger.signal || 'unnamed signal'}"`
      if (type === 'activity') {
        const kindCount = (trigger.kinds ?? []).filter((kind) => kind.trim()).length
        if (!trigger.source) return 'Pick an app and at least one event type to watch'
        return `Watches ${trigger.source} for ${kindCount} event type${kindCount === 1 ? '' : 's'}`
      }
      if (type === 'slack') {
        return trigger.channelId
          ? `Posts in ${trigger.channelId}${trigger.threadOnly ? ' (thread replies only)' : ''}`
          : 'Any channel in the connected Slack workspace'
      }
      if (type === 'webhook') return ctx.published === false ? `${inputLine} · publish to arm` : inputLine
      // manual keeps the original input-count line.
      return inputLine
    }
    case 'agent':
      return ctx.agentName(node.data.agentId) || 'Choose an agent'
    case 'loop':
      return node.data.over === '{{trigger.input}}' ? 'Loop over trigger input' : `Loop over ${node.data.over}`
    case 'parallel':
      return `${node.data.branches.length} branch${node.data.branches.length === 1 ? '' : 'es'}`
    case 'stop':
      return node.data.reason || undefined
    case 'tool': {
      // Native configuration reads as the integration it runs through; an
      // unbound step reads as the pick it still needs. API-request nodes
      // (http) carry their own distinct subtitle below.
      const label =
        selectedToolPresentation(ctx.toolCatalog, node.data.connectionId, node.data.toolName).brand?.label ||
        stepBrandFallback(node as { type: string; data: Record<string, unknown> })?.label
      return label ? `via ${label} integration` : 'Choose a connected app and action'
    }
    case 'http':
      return node.data.url ? `API request · ${node.data.method} ${node.data.url}` : 'Configure an API request'
    case 'transform':
      return `${node.data.fields.length} field${node.data.fields.length === 1 ? '' : 's'}`
    case 'filter':
      return node.data.note || 'Continue only if a rule matches'
    case 'switch':
      return node.data.note || `${node.data.cases.length} case${node.data.cases.length === 1 ? '' : 's'}`
    // Subtitles are humanized by the caller, so {{tokens}} below read as
    // plain-English chips, never raw braces.
    case 'variable': {
      if (node.data.note) return node.data.note
      if (node.data.op === 'initialize') {
        const typeLabel = VARIABLE_TYPE_LABELS[node.data.varType ?? 'string']
        return node.data.value?.trim() ? `${typeLabel} — starts as ${node.data.value}` : `${typeLabel} variable`
      }
      if (node.data.op === 'increment' || node.data.op === 'decrement') {
        return node.data.value?.trim() ? `By ${node.data.value}` : 'By 1'
      }
      return node.data.value?.trim() || 'Choose the value to store'
    }
    case 'data':
      return node.data.note || node.data.input?.trim() || 'Choose the data to work with'
    case 'code':
      return node.data.note || `${node.data.mode === 'each' ? 'Once per item' : 'Once for all input'} · ${node.data.language === 'python' ? 'Python' : 'JavaScript'}`
    case 'humanReview':
      return node.data.note || node.data.message.trim() || 'Write the question to ask'
    case 'output': {
      if (node.data.note) return node.data.note
      const names = node.data.outputs.map((o) => o.name.trim()).filter(Boolean)
      if (!names.length) return 'Name the results this flow returns'
      return names.length === 1 ? `Returns ${names[0]}` : `Returns ${names[0]} +${names.length - 1}`
    }
    case 'join':
      return node.data.note || 'Merge branches back into one path'
    case 'ai': {
      if (node.data.note) return node.data.note
      const gist = (node.data.instructions ?? '').trim().split('\n')[0] || (node.data.input ?? '').trim().split('\n')[0]
      return gist || 'Tell AI what to do with the input'
    }
    case 'subflow':
      return node.data.note || (node.data.flowId ? 'Runs another flow and passes back its result' : 'Choose the flow to run')
    case 'knowledge':
      return node.data.note || (node.data.query?.trim() ? undefined : 'Write what to look for')
    case 'note':
      return 'Sticky note'
    case 'wait':
      if (node.data.note) return node.data.note
      if (node.data.mode === 'webhook') return 'Wait for a callback'
      if (node.data.mode === 'until') return node.data.until?.trim() ? `Until ${node.data.until}` : 'Wait until a date/time'
      return node.data.amount?.trim() ? `Wait ${node.data.amount} ${node.data.unit ?? 'minutes'}` : 'Wait for a delay'
    default:
      return (node.data as { note?: string }).note || undefined
  }
}

/** A labeled outgoing path of a node — one source handle on the canvas, one
 *  branch column on the inline chain. `branch` is the edge tag; `undefined`
 *  means the node's plain successor edge. */
export type BranchOutput = { branch?: string; label: string; tone: 'normal' | 'error' }

/**
 * Every outgoing path a node offers, in render order. Condition and switch
 * replace the plain path with their branches; a step routing on failure gains
 * an extra amber `error` path ALONGSIDE its normal one (it still continues on
 * success). `stop` ends the flow and offers none.
 */
export function branchOutputsFor(node: FlowNode, labelCtx?: TokenLabelContext): BranchOutput[] {
  const humanize = (value: string) => (labelCtx ? humanizeTokens(value, labelCtx) : value)
  const errorPath: BranchOutput[] =
    (node.type === 'agent' || node.type === 'tool' || node.type === 'http') && node.data.onError === 'route'
      ? [{ branch: 'error', label: 'On error', tone: 'error' }]
      : []

  if (node.type === 'condition') {
    return [
      { branch: 'true', label: 'Then', tone: 'normal' },
      { branch: 'false', label: 'Otherwise', tone: 'normal' },
    ]
  }
  if (node.type === 'switch') {
    return [
      ...node.data.cases.map((c) => ({
        branch: c.id,
        label: c.label || humanize(`${c.left} ${CONDITION_OP_LABELS[c.op]} ${c.right}`),
        tone: 'normal' as const,
      })),
      { branch: 'default', label: 'default', tone: 'normal' as const },
    ]
  }
  if (node.type === 'stop') return errorPath
  return [{ label: '', tone: 'normal' }, ...errorPath]
}
