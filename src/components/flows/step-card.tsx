'use client'

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import {
  Bot,
  Braces,
  CalendarDays,
  Check,
  CircleStop,
  ClipboardCopy,
  Code2,
  BookOpen,
  Copy,
  FileText,
  Filter,
  GitBranch,
  GitMerge,
  Globe,
  Hash,
  FileOutput,
  Mail,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  Repeat,
  Rows3,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Split,
  ToggleLeft,
  Workflow,
  Trash2,
  Type,
  UserCheck,
  Variable,
  Wrench,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { cn } from '@/lib/utils'
import { AI_OPS, AI_OP_LABELS, CONDITION_OPS, CONDITION_OP_LABELS, DATA_OPS, FIELD_TYPES, VARIABLE_OPS, VARIABLE_OP_LABELS, VARIABLE_TYPES, VARIABLE_TYPE_LABELS, type AiOp, type ConditionClause, type ConditionOp, type DataOp, type FlowNode, type OutputField, type TriggerInputField, type VariableOp, type VariableType } from '@/lib/flows/graph'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { DATA_OP_HELPER, DATA_OP_INPUT_PLACEHOLDER, VARIABLE_VALUE_PLACEHOLDER, variableValueOptional } from '@/lib/flows/step-copy'
import { humanizeTokens, type TokenLabelContext } from '@/lib/flows/token-text'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { groupToolConnections, selectedToolPresentation, toolActionChoices } from '@/lib/flows/tool-presentation'
import { useWorkspaceFlows } from './use-workspace-flows'
import { triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { orgMemberLabel, type OrgMember, type ToolCatalog } from './step-drawer'
import { TriggerEditor, type TriggerData } from './trigger-editor'
import { AdvancedParamsSection } from './advanced-params'
import { DataTree } from './data-tree'
import { TokenTextEditor, type TokenTextEditorHandle } from './token-text-editor'
import { ToolArgsEditor } from './tool-args-editor'
import type { DataField } from '@/lib/flows/datatree'
import { TypewriterStatus } from '@/components/ui/typewriter-status'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'waiting' | 'skipped' | 'stopped' | 'resumed'

type Agent = { id: string; title: string }
type KeyValueRow = { key: string; value: string }
type InputKind = 'text' | 'yesno' | 'file' | 'email' | 'number' | 'date'

const NODE_ICON: Record<FlowNode['type'], typeof Bot> = {
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
  // NEUTRAL placeholder for Task 6 (builder UX) — icon/tone finalized with the editor.
  output: FileOutput,
  // NEUTRAL placeholder for Task 6 (builder UX) — icon/tone finalized with the join editor.
  join: GitMerge,
  ai: Sparkles,
  subflow: Workflow,
  knowledge: BookOpen,
}

const NODE_TONE: Record<FlowNode['type'], string> = {
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
  // NEUTRAL placeholder for Task 6 (builder UX) — finalized with the join editor.
  join: 'bg-indigo-600 text-white',
  ai: 'bg-indigo-500 text-white',
  subflow: 'bg-teal-500 text-white',
  knowledge: 'bg-rose-500 text-white',
}

const STATUS_DOT: Record<StepStatus, string> = {
  queued: 'bg-gray-300',
  running: 'bg-amber-400 animate-pulse',
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  waiting: 'bg-blue-500 animate-pulse',
  skipped: 'bg-gray-300',
  stopped: 'bg-slate-500',
  resumed: 'bg-gray-300',
}

const INPUT_TYPES: {
  id: InputKind
  label: string
  description: string
  name: string
  fieldType: OutputField['type']
  format?: 'file'
  icon: typeof Type
  tone: string
}[] = [
  { id: 'text', label: 'Text', description: 'Please enter your input', name: 'text', fieldType: 'string', icon: Type, tone: 'bg-purple-500 text-white' },
  { id: 'yesno', label: 'Yes / No', description: 'Choose yes or no.', name: 'yesNo', fieldType: 'boolean', icon: ToggleLeft, tone: 'bg-indigo-500 text-white' },
  { id: 'file', label: 'File', description: 'Upload a file to use its text.', name: 'file', fieldType: 'object', format: 'file' as const, icon: FileText, tone: 'bg-slate-700 text-white' },
  { id: 'email', label: 'Email', description: 'Enter an email address.', name: 'email', fieldType: 'string', icon: Mail, tone: 'bg-green-600 text-white' },
  { id: 'number', label: 'Number', description: 'Enter a number.', name: 'number', fieldType: 'number', icon: Hash, tone: 'bg-orange-500 text-white' },
  { id: 'date', label: 'Date', description: 'Enter a date.', name: 'date', fieldType: 'string', icon: CalendarDays, tone: 'bg-rose-500 text-white' },
]

const controlClass =
  'h-10 rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-950 outline-none transition-colors placeholder:text-slate-400 hover:border-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
// TokenTextEditor overrides that restyle the drawer-flavored defaults to match
// the card's denser slate inputs. No border color here — `invalid` red borders
// (appended after this string) must win in tailwind-merge order.
const tokenControlBase =
  'min-h-10 rounded-md bg-white px-3 py-2 text-sm text-slate-950 transition-colors empty:before:text-slate-400 hover:border-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100'
const tokenControlClass = `${tokenControlBase} border-slate-300`
const labelClass = 'text-[11px] font-semibold uppercase tracking-wide text-slate-500'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function triggerData(node: Extract<FlowNode, { type: 'trigger' }>): TriggerData {
  return isRecord(node.data.trigger) ? (node.data.trigger as TriggerData) : { type: 'manual' }
}

function inputTypeForField(field: OutputField & { format?: string }) {
  if (field.format === 'file') return INPUT_TYPES.find((type) => type.id === 'file')!
  const text = `${field.name} ${field.description ?? ''}`.toLowerCase()
  if (field.type === 'boolean') return INPUT_TYPES.find((type) => type.id === 'yesno')!
  if (field.type === 'number') return INPUT_TYPES.find((type) => type.id === 'number')!
  if (text.includes('email')) return INPUT_TYPES.find((type) => type.id === 'email')!
  if (text.includes('date')) return INPUT_TYPES.find((type) => type.id === 'date')!
  if (field.type === 'object' || field.type === 'array' || text.includes('file')) return INPUT_TYPES.find((type) => type.id === 'file')!
  return INPUT_TYPES.find((type) => type.id === 'text')!
}

function uniqueFieldName(base: string, fields: OutputField[]): string {
  const names = new Set(fields.map((field) => field.name))
  if (!names.has(base)) return base
  let index = 2
  while (names.has(`${base}${index}`)) index += 1
  return `${base}${index}`
}

function parseKeyValueRows(value?: string): KeyValueRow[] {
  if (!value?.trim()) return [{ key: '', value: '' }]
  try {
    const parsed = JSON.parse(value)
    if (isRecord(parsed)) {
      const rows = Object.entries(parsed).map(([key, raw]) => ({
        key,
        value: typeof raw === 'string' ? raw : JSON.stringify(raw),
      }))
      return rows.length ? rows : [{ key: '', value: '' }]
    }
  } catch {
    return [{ key: '', value }]
  }
  return [{ key: '', value }]
}

function serializeKeyValueRows(rows: KeyValueRow[]): string {
  const entries = rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value] as const)
  if (!entries.length) return ''
  return JSON.stringify(Object.fromEntries(entries), null, 2)
}

function defaultAgentInput(value?: string): boolean {
  const trimmed = (value ?? '').trim()
  return trimmed === 'Use this flow input:\n{{trigger.input}}' || trimmed === 'Process this item:\n{{item}}'
}

function conditionClauses(node: Extract<FlowNode, { type: 'condition' | 'filter' }>): ConditionClause[] {
  if (node.data.clauses?.length) return node.data.clauses
  if (node.type === 'condition' && (node.data.left !== undefined || node.data.right !== undefined)) {
    return [{ left: node.data.left ?? '', op: node.data.op ?? 'contains', right: node.data.right ?? '' }]
  }
  return [{ left: '', op: 'contains', right: '' }]
}

function transformFields(node: Extract<FlowNode, { type: 'transform' }>): { name: string; value: string }[] {
  return node.data.fields.length ? node.data.fields : [{ name: '', value: '' }]
}

function stopEvent(event: React.MouseEvent | React.FocusEvent) {
  event.stopPropagation()
}

/** The one affordance a collapsed card may keep showing (MS parity). */
function collapsedAffordance(node: FlowNode): React.ReactNode | null {
  if (node.type !== 'trigger') return null
  const trigger = triggerData(node)
  if ((trigger.type ?? 'manual') !== 'manual') return null
  const count = triggerInputFieldsFromTrigger(trigger).length
  return (
    <span className="pointer-events-none flex items-center gap-3 py-2 text-base font-semibold text-slate-700">
      <Plus className="h-5 w-5" />
      {count > 0 ? `${count} input${count === 1 ? '' : 's'} — add another` : 'Add an input'}
    </span>
  )
}

// Sentinel for activeFieldRef: a non-token input (labels, field names, KV
// keys, …) is focused, so datatree inserts must be a no-op — falling back to
// the step's primary field would silently write to a field the user is not
// editing. Mirrors step-drawer.tsx.
const NON_TOKEN_FOCUSED = 'non-token-focused'

// Where a datatree click lands when no chip editor has been focused yet: the
// step type's primary token field.
const DEFAULT_EDITOR_KEYS: Partial<Record<FlowNode['type'], string>> = {
  agent: 'agent.input',
  ai: 'ai.instructions',
  http: 'http.body',
  knowledge: 'knowledge.query',
  loop: 'loop.over',
  subflow: 'subflow.input',
  transform: 'xf.0',
  condition: 'clause.0.left',
  filter: 'clause.0.left',
  switch: 'sw.0.left',
  variable: 'var.value',
  data: 'data.input',
  humanReview: 'hr.message',
  output: 'out.0.value',
}

// Chip editors still render when the caller omitted labelCtx: chips fall back
// to generic step labels instead of crashing.
const EMPTY_LABEL_CTX: TokenLabelContext = { stepLabels: {} }

type TokenEditorWiring = {
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  blockActive: () => void
  unblockActive: () => void
}

export function StepCard({
  node,
  index,
  title,
  subtitle,
  status,
  issues,
  selected,
  highlighted,
  agents,
  members,
  toolCatalog,
  dataFields,
  labelCtx,
  variableNames,
  flowId,
  published,
  onChange,
  onClick,
  onRefreshAgents,
  onDuplicate,
  onMakeSubflow,
  onDelete,
  draggable,
  onDragStartNode,
  onDragEndNode,
}: {
  node: FlowNode
  index?: number
  title: string
  subtitle?: string
  status?: StepStatus
  issues?: { errors: number; warnings: number; items: { level: 'error' | 'warning'; message: string }[] }
  selected?: boolean
  highlighted?: boolean
  agents: Agent[]
  members?: OrgMember[]
  toolCatalog: ToolCatalog
  dataFields?: DataField[]
  labelCtx?: TokenLabelContext
  variableNames?: string[]
  flowId?: string
  published?: boolean
  onChange?: (node: FlowNode) => void
  onClick?: () => void
  onRefreshAgents?: () => void
  onDuplicate?: () => void
  onMakeSubflow?: () => void
  onDelete?: () => void
  draggable?: boolean
  onDragStartNode?: (id: string) => void
  onDragEndNode?: () => void
}) {
  const Icon = NODE_ICON[node.type]
  const toolPresentation =
    node.type === 'tool'
      ? selectedToolPresentation(toolCatalog, node.data.connectionId, node.data.toolName)
      : null
  // Read-only surfaces never show raw {{token}} syntax: humanize any node data
  // echoed in the collapsed summary or tooltips. Storage keeps canonical tokens.
  const humanize = (value: string) => (labelCtx ? humanizeTokens(value, labelCtx) : value)
  const displayTitle = humanize(title)
  const displaySubtitle = subtitle ? humanize(subtitle) : undefined
  const update = (updated: FlowNode) => onChange?.(updated)
  const [renaming, setRenaming] = useState(false)
  const [codeOpen, setCodeOpen] = useState(false)
  const isTrigger = node.type === 'trigger'
  const label = (node.data as { label?: string }).label ?? ''
  const setLabel = (value: string) => onChange?.({ ...node, data: { ...node.data, label: value || undefined } } as FlowNode)
  const copyNodeJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(node, null, 2))
      toast.success(isTrigger ? 'Trigger JSON copied.' : 'Step JSON copied.')
    } catch {
      toast.error('Could not copy to the clipboard.')
    }
  }
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onClick?.()
  }
  // Chip-editor handles keyed by field, so a datatree click inserts a token
  // chip at the caret of the last-focused editor (mirrors step-drawer.tsx).
  const editorHandles = useRef<Map<string, TokenTextEditorHandle | null>>(new Map())
  const editorRefCallbacks = useRef<Map<string, (handle: TokenTextEditorHandle | null) => void>>(new Map())
  const activeFieldRef = useRef<string | null>(null)
  const activeEditorElRef = useRef<HTMLElement | null>(null)
  const tokenPopoverRef = useRef<HTMLDivElement | null>(null)
  const [tokenPopover, setTokenPopover] = useState<{ top: number; left: number; width: number } | null>(null)
  const registerEditor = (key: string) => {
    let callback = editorRefCallbacks.current.get(key)
    if (!callback) {
      callback = (handle: TokenTextEditorHandle | null) => {
        editorHandles.current.set(key, handle)
      }
      editorRefCallbacks.current.set(key, callback)
    }
    return callback
  }
  const focusEditor = (key: string) => () => {
    activeFieldRef.current = key
    const el = document.activeElement instanceof HTMLElement ? document.activeElement : null
    activeEditorElRef.current = el
    if (selected && dataFields && dataFields.length > 0 && el) {
      // getBoundingClientRect() already returns post-transform (zoomed) coordinates, so the
      // popover lines up with the field regardless of the canvas zoom level — no scale compensation needed.
      const rect = el.getBoundingClientRect()
      setTokenPopover({
        top: rect.bottom + 6,
        left: Math.min(rect.left, window.innerWidth - 380),
        width: Math.max(320, Math.min(rect.width, 420)),
      })
    }
  }
  // While any non-token input is focused, datatree inserts are blocked
  // entirely; blur restores the normal fallback behavior.
  const blockActive = () => {
    activeFieldRef.current = NON_TOKEN_FOCUSED
  }
  const unblockActive = () => {
    if (activeFieldRef.current === NON_TOKEN_FOCUSED) activeFieldRef.current = null
  }
  // Insert a token chip at the caret of the last-focused editor; fall back to
  // the step's primary field when nothing has been focused yet. DataTree emits
  // braced `{{token}}`s; the chip editor takes the bare path.
  const insertToken = (token: string) => {
    if (activeFieldRef.current === NON_TOKEN_FOCUSED) return
    const path = token.startsWith('{{') && token.endsWith('}}') ? token.slice(2, -2).trim() : token
    const active = activeFieldRef.current ? editorHandles.current.get(activeFieldRef.current) : null
    const fallbackKey = DEFAULT_EDITOR_KEYS[node.type]
    const editor = active ?? (fallbackKey ? editorHandles.current.get(fallbackKey) : null)
    editor?.insertToken(path)
  }
  const tokenWiring: TokenEditorWiring = {
    labelCtx: labelCtx ?? EMPTY_LABEL_CTX,
    registerEditor,
    focusEditor,
    blockActive,
    unblockActive,
  }
  const showErrors = Boolean(issues?.errors)
  const issuesButtonRef = useRef<HTMLButtonElement | null>(null)
  const issuesPopoverRef = useRef<HTMLDivElement | null>(null)
  const [issuesPopover, setIssuesPopover] = useState<{ top: number; left: number } | null>(null)
  // Errors first so the most blocking problems lead the list.
  const issueItems = issues ? [...issues.items].sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1)) : []

  useEffect(() => {
    if (!selected) {
      setTokenPopover(null)
      activeFieldRef.current = null
      activeEditorElRef.current = null
    }
  }, [selected])

  // Issues fixed while the popover is open: drop the popover with the badge.
  useEffect(() => {
    if (!issues || (issues.errors === 0 && issues.warnings === 0)) setIssuesPopover(null)
  }, [issues])

  useEffect(() => {
    if (!issuesPopover) return
    const close = () => setIssuesPopover(null)
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (issuesPopoverRef.current?.contains(target)) return
      if (issuesButtonRef.current?.contains(target)) return
      close()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', close, true)
    }
  }, [issuesPopover])

  useEffect(() => {
    if (!tokenPopover) return
    const close = () => setTokenPopover(null)
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (tokenPopoverRef.current?.contains(target)) return
      if (activeEditorElRef.current?.contains(target)) return
      close()
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', close, true)
    }
  }, [tokenPopover])

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation()
        onClick?.()
      }}
      onKeyDown={onRootKeyDown}
      className={cn(
        'w-full rounded-[18px] border bg-white text-left shadow-[0_2px_10px_rgba(15,23,42,0.08)] outline-none transition-all duration-fast',
        'hover:border-slate-300 hover:shadow-[0_8px_24px_rgba(15,23,42,0.12)] focus-visible:ring-2 focus-visible:ring-blue-200',
        selected
          ? 'border-blue-500 ring-2 ring-blue-100'
          : highlighted
            ? 'border-indigo-400 ring-2 ring-indigo-200 animate-pulse'
            : issues?.errors
              ? 'border-red-400 ring-2 ring-red-100'
              : issues?.warnings
                ? 'border-amber-300'
                : 'border-slate-200',
      )}
    >
      <div className="flex items-center gap-5 px-5 py-5">
        {toolPresentation?.brand ? (
          <span
            draggable={draggable}
            onDragStart={(event) => {
              event.dataTransfer.setData('text/flow-node-id', node.id)
              event.dataTransfer.effectAllowed = 'move'
              onDragStartNode?.(node.id)
            }}
            onDragEnd={() => onDragEndNode?.()}
            title="Drag to reorder"
            className={cn('shrink-0', draggable && 'cursor-grab active:cursor-grabbing')}
          >
            <IntegrationLogo
              slug={toolPresentation.brand.slug}
              name={toolPresentation.brand.label}
              className="h-[52px] w-[52px] rounded-lg border border-slate-200 bg-white p-2 shadow-sm"
            />
          </span>
        ) : (
          <span
            draggable={draggable}
            onDragStart={(event) => {
              event.dataTransfer.setData('text/flow-node-id', node.id)
              event.dataTransfer.effectAllowed = 'move'
              onDragStartNode?.(node.id)
            }}
            onDragEnd={() => onDragEndNode?.()}
            title="Drag to reorder"
            className={cn(
              'flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-lg',
              NODE_TONE[node.type],
              draggable && 'cursor-grab active:cursor-grabbing',
            )}
          >
            <Icon className="h-6 w-6" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {typeof index === 'number' && <span className="text-xs font-semibold text-slate-400">{index}</span>}
            {renaming ? (
              <span className="flex items-center gap-1.5" onClick={stopEvent}>
                <input
                  autoFocus
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === 'Escape') setRenaming(false)
                  }}
                  onFocus={blockActive}
                  onBlur={() => {
                    unblockActive()
                    setRenaming(false)
                  }}
                  className="h-9 min-w-0 flex-1 rounded-md border border-blue-400 bg-white px-2 text-lg font-semibold text-slate-950 outline-none ring-2 ring-blue-100"
                  placeholder={displayTitle}
                  aria-label="Step name"
                />
                <button
                  type="button"
                  onClick={() => setRenaming(false)}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100"
                  aria-label="Done renaming"
                >
                  <Check className="h-4 w-4" />
                </button>
              </span>
            ) : (
              <h3 className="truncate text-lg font-semibold text-slate-950">{displayTitle}</h3>
            )}
          </div>
          {displaySubtitle && <p className="mt-0.5 truncate text-sm text-slate-500">{displaySubtitle}</p>}
        </div>
        {issues && (issues.errors > 0 || issues.warnings > 0) && (
          <button
            ref={issuesButtonRef}
            type="button"
            aria-label="Show issues"
            aria-expanded={Boolean(issuesPopover)}
            onClick={(event) => {
              event.stopPropagation()
              if (issuesPopover) {
                setIssuesPopover(null)
                return
              }
              const rect = event.currentTarget.getBoundingClientRect()
              setIssuesPopover({
                top: rect.bottom + 6,
                left: Math.min(rect.left, window.innerWidth - 336),
              })
            }}
            className={cn(
              'flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1 text-[11px] font-bold text-white',
              issues.errors > 0 ? 'bg-red-500' : 'bg-amber-500',
            )}
          >
            {issues.errors + issues.warnings}
          </button>
        )}
        {status && (
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-700">
            <span className={cn('h-2 w-2 rounded-full', STATUS_DOT[status])} />
            {status === 'running' ? <TypewriterStatus seed={node.id.length ? node.id.charCodeAt(node.id.length - 1) : 0} /> : status}
          </span>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onClick?.()
          }}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 sm:flex"
          aria-label="Open step settings"
          title="Open step settings"
        >
          <PanelRight className="h-5 w-5" />
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onClick={(event) => event.stopPropagation()}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Step options"
              title="Step options"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            {!isTrigger && onDelete && (
              <>
                <DropdownMenuItem onSelect={onDelete} className="text-red-600 focus:text-red-700">
                  <Trash2 className="h-4 w-4" /> Delete
                  <span className="ml-auto pl-4 text-xs text-slate-400">Del</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={copyNodeJson}>
              <ClipboardCopy className="h-4 w-4" /> {isTrigger ? 'Copy trigger JSON' : 'Copy step JSON'}
              <span className="ml-auto pl-4 text-xs text-slate-400">⌘C</span>
            </DropdownMenuItem>
            {!isTrigger && (
              <DropdownMenuItem onSelect={() => setRenaming(true)}>
                <Pencil className="h-4 w-4" /> Rename
              </DropdownMenuItem>
            )}
            {!isTrigger && onDuplicate && (
              <DropdownMenuItem onSelect={onDuplicate}>
                <Copy className="h-4 w-4" /> Duplicate
              </DropdownMenuItem>
            )}
            {!isTrigger && onMakeSubflow && (
              <DropdownMenuItem onSelect={onMakeSubflow}>
                <Workflow className="h-4 w-4" /> Make a subflow…
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onClick?.()}>
              <Settings2 className="h-4 w-4" /> Open settings
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setCodeOpen(true)}>
              <Code2 className="h-4 w-4" /> Code view
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <AnimatePresence initial={false}>
        {selected ? (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div onClick={stopEvent} onFocus={stopEvent} className="border-t border-slate-200 px-5 py-4">
              {renderNodeBody({ node, agents, members, toolCatalog, dataFields, update, onRefreshAgents, tokenWiring, showErrors, variableNames, flowId, published })}
            </div>
          </motion.div>
        ) : (
          collapsedAffordance(node) && (
            <div className="border-t border-slate-200 px-5 py-1.5">{collapsedAffordance(node)}</div>
          )
        )}
      </AnimatePresence>
      {codeOpen && (
        <div onClick={stopEvent} className="border-t border-slate-200 px-5 py-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Code view</p>
            <div className="flex items-center gap-3">
              <button type="button" onClick={copyNodeJson} className="text-xs font-semibold text-blue-700 hover:text-blue-900">
                Copy
              </button>
              <button type="button" onClick={() => setCodeOpen(false)} className="text-xs font-semibold text-slate-500 hover:text-slate-900">
                Close
              </button>
            </div>
          </div>
          <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-3 text-xs leading-5 text-slate-100">{JSON.stringify(node, null, 2)}</pre>
        </div>
      )}
      {selected && tokenPopover && dataFields && dataFields.length > 0 &&
        createPortal(
          <div
            ref={tokenPopoverRef}
            style={{ position: 'fixed', top: tokenPopover.top, left: tokenPopover.left, width: tokenPopover.width, zIndex: 60 }}
            className="max-h-72 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_16px_48px_rgba(15,23,42,0.18)]"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <DataTree fields={dataFields} onInsert={insertToken} title="Insert data" emptyMessage="No earlier step data is available yet." />
          </div>,
          document.body,
        )}
      {issuesPopover && issueItems.length > 0 &&
        createPortal(
          <div
            ref={issuesPopoverRef}
            style={{ position: 'fixed', top: issuesPopover.top, left: issuesPopover.left, zIndex: 60 }}
            className="w-max max-w-xs rounded-xl border border-slate-200 bg-white p-3 shadow-[0_16px_48px_rgba(15,23,42,0.18)]"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <ul className="space-y-2">
              {issueItems.map((item, itemIndex) => (
                <li key={itemIndex} className="flex items-start gap-2 text-sm text-slate-700">
                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', item.level === 'error' ? 'bg-red-500' : 'bg-amber-500')} />
                  <span className="min-w-0">{humanize(item.message)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 border-t border-slate-200 pt-2">
              <button
                type="button"
                onClick={() => {
                  setIssuesPopover(null)
                  onClick?.()
                }}
                className="text-xs font-semibold text-blue-700 hover:text-blue-900"
              >
                Fix in settings
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}

function renderNodeBody({
  node,
  agents,
  members,
  toolCatalog,
  dataFields,
  update,
  onRefreshAgents,
  tokenWiring,
  showErrors,
  variableNames,
  flowId,
  published,
}: {
  node: FlowNode
  agents: Agent[]
  members?: OrgMember[]
  toolCatalog: ToolCatalog
  dataFields?: DataField[]
  update: (node: FlowNode) => void
  onRefreshAgents?: () => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
  variableNames?: string[]
  flowId?: string
  published?: boolean
}) {
  switch (node.type) {
    case 'trigger':
      return <TriggerBody node={node} update={update} flowId={flowId} published={published} />
    case 'agent':
      return <AgentBody node={node} agents={agents} update={update} onRefreshAgents={onRefreshAgents} tokenWiring={tokenWiring} showErrors={showErrors} />
    case 'ai':
      return <AiBody node={node} update={update} tokenWiring={tokenWiring} showErrors={showErrors} />
    case 'subflow':
      return <SubflowBody node={node} update={update} tokenWiring={tokenWiring} flowId={flowId} showErrors={showErrors} />
    case 'knowledge':
      return <KnowledgeBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'http':
      return <HttpBody node={node} toolCatalog={toolCatalog} update={update} tokenWiring={tokenWiring} showErrors={showErrors} />
    case 'tool':
      return <ToolBody node={node} toolCatalog={toolCatalog} dataFields={dataFields ?? []} update={update} showErrors={showErrors} tokenWiring={tokenWiring} />
    case 'condition':
      return <ConditionBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'filter':
      return <ConditionBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'transform':
      return <TransformBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'loop':
      return <LoopBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'parallel':
      return <p className="text-sm text-slate-600">Runs {node.data.branches.length || 0} branches side by side. Add and configure branch steps from the settings panel.</p>
    case 'switch':
      return <SwitchBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'stop':
      return <StopBody node={node} update={update} />
    case 'variable':
      return <VariableBody node={node} update={update} tokenWiring={tokenWiring} variableNames={variableNames} showErrors={showErrors} />
    case 'data':
      return <DataBody node={node} update={update} tokenWiring={tokenWiring} showErrors={showErrors} />
    case 'humanReview':
      return <HumanReviewBody node={node} members={members} update={update} tokenWiring={tokenWiring} showErrors={showErrors} />
    case 'output':
      return <OutputBody node={node} update={update} tokenWiring={tokenWiring} />
    case 'join':
      return <p className="text-sm text-slate-600">A merge point with no settings. Point the ends of different branches at this step so the steps after it run once, on whichever path actually ran.</p>
  }
}

function TriggerBody({
  node,
  update,
  flowId,
  published,
}: {
  node: Extract<FlowNode, { type: 'trigger' }>
  update: (node: FlowNode) => void
  flowId?: string
  published?: boolean
}) {
  const [choosingInput, setChoosingInput] = useState(false)
  const trigger = triggerData(node)
  const fields = triggerInputFieldsFromTrigger(trigger)
  const setTrigger = (next: TriggerData) => update({ ...node, data: { ...node.data, trigger: next } })
  const addField = (kind: InputKind) => {
    const option = INPUT_TYPES.find((type) => type.id === kind) ?? INPUT_TYPES[0]
    setTrigger({
      ...trigger,
      inputFields: [
        ...fields,
        {
          name: uniqueFieldName(option.name, fields),
          type: option.fieldType,
          description: option.description,
          ...(option.format ? { format: option.format } : {}),
        },
      ],
    })
    setChoosingInput(false)
  }
  const updateField = (index: number, patch: Partial<TriggerInputField>) => {
    setTrigger({
      ...trigger,
      inputFields: fields.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)),
    })
  }
  const removeField = (index: number) => {
    setTrigger({ ...trigger, inputFields: fields.filter((_, fieldIndex) => fieldIndex !== index) })
  }

  return (
    <div className="space-y-4">
      <TriggerEditor
        flowId={flowId ?? ''}
        trigger={trigger}
        onChange={setTrigger}
        published={published}
        classes={{ field: controlClass, label: labelClass }}
      />
      {fields.length > 0 && (
        <div className="space-y-3">
          {fields.map((field, fieldIndex) => {
            const inputType = inputTypeForField(field)
            const InputIcon = inputType.icon
            return (
              <div key={`${field.name}-${fieldIndex}`} className="grid gap-3 border-b border-slate-200 pb-3 sm:grid-cols-[42px_minmax(120px,0.7fr)_minmax(150px,1fr)_auto_36px]">
                <span className={cn('flex h-10 w-10 items-center justify-center rounded-full', inputType.tone)}>
                  <InputIcon className="h-5 w-5" />
                </span>
                <input
                  value={field.name}
                  onChange={(event) => updateField(fieldIndex, { name: event.target.value })}
                  className={controlClass}
                  placeholder={inputType.label}
                  aria-label="Input name"
                />
                <input
                  value={field.description ?? ''}
                  onChange={(event) => updateField(fieldIndex, { description: event.target.value })}
                  className={controlClass}
                  placeholder={inputType.description}
                  aria-label="Prompt shown for input"
                />
                <label className="flex items-center gap-1.5 text-xs font-medium text-slate-600" title="The run must supply this value">
                  <input
                    type="checkbox"
                    checked={field.required === true}
                    onChange={(event) => updateField(fieldIndex, { required: event.target.checked || undefined })}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600"
                  />
                  Required
                </label>
                <button
                  type="button"
                  onClick={() => removeField(fieldIndex)}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove input"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
                <div className="min-w-0 sm:col-start-2 sm:col-end-4">
                  <input
                    value={field.default ?? ''}
                    onChange={(event) => updateField(fieldIndex, { default: event.target.value || undefined })}
                    className={cn(controlClass, 'w-full min-w-0')}
                    placeholder="Default value if none is provided"
                    aria-label="Default value"
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}

      {choosingInput ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="mb-3 text-sm font-semibold text-slate-900">Choose the type of user input</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {INPUT_TYPES.map((type) => {
              const InputIcon = type.icon
              return (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => addField(type.id)}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3 text-left transition-colors hover:border-blue-300 hover:bg-blue-50"
                >
                  <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full', type.tone)}>
                    <InputIcon className="h-4 w-4" />
                  </span>
                  <span>
                    <span className="block text-sm font-semibold text-slate-900">{type.label}</span>
                    <span className="block text-xs text-slate-500">{type.description}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setChoosingInput(true)}
          className="flex w-full items-center gap-3 rounded-lg py-2 text-left text-base font-semibold text-slate-700 hover:text-blue-700"
        >
          <Plus className="h-5 w-5" /> Add an input
        </button>
      )}
    </div>
  )
}

function KnowledgeBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'knowledge' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>What to look for</label>
        <TokenTextEditor
          ref={registerEditor('knowledge.query')}
          multiline
          rows={2}
          value={node.data.query ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('knowledge.query')}
          onChange={(query) => update({ ...node, data: { ...node.data, query } })}
          className={tokenControlClass}
          placeholder="Describe what you need — add flow data from the picker."
          ariaLabel="Knowledge search query"
        />
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>How many passages</label>
        <input
          type="number"
          min={1}
          max={20}
          value={node.data.topK ?? 5}
          onChange={(event) => update({ ...node, data: { ...node.data, topK: Number(event.target.value) || undefined } })}
          onFocus={blockActive}
          onBlur={unblockActive}
          className={controlClass}
          aria-label="How many passages"
        />
      </div>
      <p className="text-xs text-slate-500">Searches the documents uploaded to your workspace and outputs the best-matching passages as a list.</p>
    </div>
  )
}

function SubflowBody({
  node,
  update,
  tokenWiring,
  flowId,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'subflow' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  flowId?: string
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const { flows, loading } = useWorkspaceFlows()
  const selectable = flows.filter((flow) => flow.id !== flowId)
  const selected = flows.find((flow) => flow.id === node.data.flowId)
  const childFields = (selected?.inputFields ?? []).filter((field) => field.name.trim())
  const inputs = node.data.inputs ?? {}
  const setInput = (name: string, value: string) => {
    const next = { ...inputs, [name]: value }
    if (!value) delete next[name]
    update({ ...node, data: { ...node.data, inputs: Object.keys(next).length ? next : undefined } })
  }
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Flow to run <span className="text-red-500">*</span></label>
        <select
          value={node.data.flowId}
          onChange={(event) => update({ ...node, data: { ...node.data, flowId: event.target.value, inputs: undefined } })}
          className={cn(controlClass, showErrors && !node.data.flowId && 'border-red-400 focus:border-red-500')}
          aria-label="Flow to run"
        >
          <option value="">{loading ? 'Loading flows…' : 'Choose a flow'}</option>
          {selectable.map((flow) => (
            <option key={flow.id} value={flow.id}>
              {flow.name}
              {flow.published ? '' : ' (not published yet)'}
            </option>
          ))}
        </select>
        {selected && !selected.published && (
          <p className="text-xs text-amber-600">This flow has never been published — publish it before running it from here.</p>
        )}
      </div>
      {childFields.length > 0 ? (
        <div className="grid gap-2">
          <label className={labelClass}>Inputs it expects</label>
          {childFields.map((field) => (
            <div key={field.name} className="grid gap-1">
              <p className="text-xs font-medium text-slate-600">{field.name}{field.required ? ' (required)' : ''}</p>
              <TokenTextEditor
                ref={registerEditor(`subflow.${field.name}`)}
                value={inputs[field.name] ?? ''}
                labelCtx={labelCtx}
                onFocus={focusEditor(`subflow.${field.name}`)}
                onChange={(value) => setInput(field.name, value)}
                className={tokenControlClass}
                placeholder={field.description || 'Add a value or pick flow data'}
                ariaLabel={`Value for ${field.name}`}
              />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-2">
          <label className={labelClass}>Input to send it</label>
          <TokenTextEditor
            ref={registerEditor('subflow.input')}
            multiline
            rows={2}
            value={node.data.input ?? ''}
            labelCtx={labelCtx}
            onFocus={focusEditor('subflow.input')}
            onChange={(input) => update({ ...node, data: { ...node.data, input } })}
            className={tokenControlClass}
            placeholder="What the flow receives as its run input."
            ariaLabel="Input to send the flow"
          />
        </div>
      )}
      <p className="text-xs text-slate-500">Runs the flow&apos;s <strong>published</strong> version and passes its result to later steps.</p>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function AiBody({
  node,
  update,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'ai' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const aiOp = node.data.aiOp
  const outputFields = node.data.outputFields ?? []
  const categories = node.data.categories ?? []
  const setOutputFields = (fields: OutputField[]) =>
    update({ ...node, data: { ...node.data, outputFields: fields.length ? fields : undefined } })
  const setCategories = (next: string[]) =>
    update({ ...node, data: { ...node.data, categories: next.length ? next : undefined } })
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Operation</label>
        <select
          value={aiOp}
          onChange={(event) => update({ ...node, data: { ...node.data, aiOp: event.target.value as AiOp } })}
          className={controlClass}
        >
          {AI_OPS.map((op) => (
            <option key={op} value={op}>
              {AI_OP_LABELS[op]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>{aiOp === 'ask' ? 'Prompt' : 'Guidance (optional)'}</label>
        <TokenTextEditor
          ref={registerEditor('ai.instructions')}
          multiline
          rows={3}
          value={node.data.instructions ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('ai.instructions')}
          onChange={(instructions) => update({ ...node, data: { ...node.data, instructions } })}
          className={tokenControlClass}
          placeholder={aiOp === 'ask' ? 'Tell AI what to do with the input.' : 'Optional extra direction for this operation.'}
          ariaLabel="AI instructions"
        />
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Input</label>
        <TokenTextEditor
          ref={registerEditor('ai.input')}
          multiline
          rows={2}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('ai.input')}
          onChange={(input) => update({ ...node, data: { ...node.data, input } })}
          className={tokenControlClass}
          placeholder="The content to work on — add flow data from the picker."
          ariaLabel="AI input"
        />
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Model</label>
        <select
          value={node.data.model ?? 'fast'}
          onChange={(event) => update({ ...node, data: { ...node.data, model: event.target.value === 'smart' ? 'smart' : undefined } })}
          className={controlClass}
        >
          <option value="fast">Fast (default)</option>
          <option value="smart">Smart (higher quality, slower)</option>
        </select>
      </div>
      {aiOp === 'extract' && (
        <div className="grid gap-2">
          <label className={labelClass}>Fields to extract</label>
          <div className="space-y-2">
            {outputFields.map((field, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_120px_36px]">
                <input
                  value={field.name}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, name: event.target.value } : entry)))}
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  className={cn(controlClass, showErrors && !field.name.trim() && 'border-red-400 focus:border-red-500')}
                  placeholder="fieldName"
                  aria-label={`Extract field ${index + 1} name`}
                />
                <select
                  value={field.type}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, type: event.target.value as OutputField['type'] } : entry)))}
                  className={controlClass}
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setOutputFields(outputFields.filter((_, j) => j !== index))}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove field"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setOutputFields([...outputFields, { name: '', type: 'string' }])}
              className="text-sm font-semibold text-blue-700 hover:text-blue-900"
            >
              Add field
            </button>
          </div>
        </div>
      )}
      {aiOp === 'categorize' && (
        <div className="grid gap-2">
          <label className={labelClass}>Categories</label>
          <div className="space-y-2">
            {categories.map((category, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_36px]">
                <input
                  value={category}
                  onChange={(event) => setCategories(categories.map((entry, j) => (j === index ? event.target.value : entry)))}
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  className={cn(controlClass, showErrors && !category.trim() && 'border-red-400 focus:border-red-500')}
                  placeholder="e.g. Urgent"
                  aria-label={`Category ${index + 1}`}
                />
                <button
                  type="button"
                  onClick={() => setCategories(categories.filter((_, j) => j !== index))}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove category"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setCategories([...categories, ''])}
              className="text-sm font-semibold text-blue-700 hover:text-blue-900"
            >
              Add category
            </button>
          </div>
        </div>
      )}
      {aiOp === 'score' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-2">
            <label className={labelClass}>Lowest score</label>
            <input
              type="number"
              value={node.data.scoreMin ?? 1}
              onChange={(event) => update({ ...node, data: { ...node.data, scoreMin: Number(event.target.value) } })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={controlClass}
              aria-label="Lowest score"
            />
          </div>
          <div className="grid gap-2">
            <label className={labelClass}>Highest score</label>
            <input
              type="number"
              value={node.data.scoreMax ?? 10}
              onChange={(event) => update({ ...node, data: { ...node.data, scoreMax: Number(event.target.value) } })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={controlClass}
              aria-label="Highest score"
            />
          </div>
        </div>
      )}
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function AgentBody({
  node,
  agents,
  update,
  onRefreshAgents,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'agent' }>
  agents: Agent[]
  update: (node: FlowNode) => void
  onRefreshAgents?: () => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const isDefaultInput = defaultAgentInput(node.data.input)
  const responseFormat = node.data.responseFormat ?? 'text'
  const outputFields = node.data.outputFields ?? []
  const setOutputFields = (fields: OutputField[]) =>
    update({ ...node, data: { ...node.data, outputFields: fields.length ? fields : undefined } })
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Agent <span className="text-red-500">*</span></label>
        <div className="flex items-center gap-2">
          <select
            value={node.data.agentId}
            onChange={(event) => update({ ...node, data: { ...node.data, agentId: event.target.value } })}
            className={cn(controlClass, 'min-w-0 flex-1', showErrors && !node.data.agentId && 'border-red-400 focus:border-red-500')}
          >
            <option value="">Choose an agent</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.title}
              </option>
            ))}
          </select>
          {onRefreshAgents && (
            <button
              type="button"
              onClick={onRefreshAgents}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-slate-300 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              aria-label="Refresh agent list"
              title="Refresh agent list"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          )}
          <a
            href="/dashboard"
            target="_blank"
            rel="noreferrer"
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-md border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            title="Create a new agent on the dashboard"
          >
            <Plus className="h-4 w-4" /> New
          </a>
        </div>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Message to agent</label>
        <TokenTextEditor
          ref={registerEditor('agent.input')}
          multiline
          rows={4}
          value={isDefaultInput ? '' : node.data.input ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('agent.input')}
          onChange={(input) => update({ ...node, data: { ...node.data, input } })}
          className={tokenControlClass}
          placeholder={isDefaultInput ? 'Uses the trigger input by default. Add instructions here if needed.' : 'Tell the agent what to do at this step.'}
          ariaLabel="Message to agent"
        />
      </div>
      <div className="flex items-start justify-between gap-3 rounded-lg bg-slate-50 p-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Request human assistance when unsure</p>
          <p className="mt-0.5 text-xs text-slate-500">When the agent isn&apos;t sure how to proceed, the flow pauses and asks for input.</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={node.data.humanAssistance !== false}
          aria-label="Request human assistance when unsure"
          onClick={() => update({ ...node, data: { ...node.data, humanAssistance: node.data.humanAssistance === false ? undefined : false } })}
          className={cn(
            'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
            node.data.humanAssistance !== false ? 'bg-blue-600' : 'bg-slate-300',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all',
              node.data.humanAssistance !== false ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </button>
      </div>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <label className={labelClass}>Agent response</label>
          <select
            value={responseFormat}
            onChange={(event) =>
              update({ ...node, data: { ...node.data, responseFormat: event.target.value === 'structured' ? 'structured' : undefined } })
            }
            className="h-8 rounded-md border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 outline-none"
          >
            <option value="text">Text only</option>
            <option value="structured">Structured</option>
          </select>
        </div>
        <p className="text-xs text-slate-500">
          {responseFormat === 'structured'
            ? 'The agent must reply with JSON matching these properties; each becomes data for later steps.'
            : 'The agent replies with plain text. Switch to Structured to map fields into later steps.'}
        </p>
        {responseFormat === 'structured' && (
          <div className="space-y-2">
            {outputFields.map((field, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[1fr_120px_36px]">
                <input
                  value={field.name}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, name: event.target.value } : entry)))}
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  className={controlClass}
                  placeholder="propertyName"
                />
                <select
                  value={field.type}
                  onChange={(event) => setOutputFields(outputFields.map((entry, j) => (j === index ? { ...entry, type: event.target.value as OutputField['type'] } : entry)))}
                  className={controlClass}
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setOutputFields(outputFields.filter((_, j) => j !== index))}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
                  aria-label="Remove property"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => setOutputFields([...outputFields, { name: '', type: 'string' }])}
              className="text-sm font-semibold text-blue-700 hover:text-blue-900"
            >
              Add property
            </button>
          </div>
        )}
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function HttpBody({
  node,
  toolCatalog,
  update,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'http' }>
  toolCatalog: ToolCatalog
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const urlInvalid = Boolean(showErrors && !node.data.url)
  const authConnections = toolCatalog.filter((entry) => parseFlowToolConnectionId(entry.id).plane === 'mcp')
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
        <div className="grid gap-2">
          <label className={labelClass}>URI <span className="text-red-500">*</span></label>
          <input
            type="url"
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={node.data.url}
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(event) => update({ ...node, data: { ...node.data, url: event.target.value } })}
            aria-invalid={urlInvalid || undefined}
            className={cn(controlClass, urlInvalid && 'border-red-400 focus:border-red-500')}
            placeholder="https://api.example.com/endpoint"
            aria-label="URI"
          />
        </div>
        <div className="grid gap-2">
          <label className={labelClass}>Method <span className="text-red-500">*</span></label>
          <select
            value={node.data.method}
            onChange={(event) => update({ ...node, data: { ...node.data, method: event.target.value as typeof node.data.method } })}
            className={controlClass}
          >
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </div>
      </div>
      <InlineKeyValue
        label="Headers"
        editorKey="http.headers"
        value={node.data.headers}
        onChange={(headers) => update({ ...node, data: { ...node.data, headers } })}
        tokenWiring={tokenWiring}
      />
      <div className="grid gap-2">
        <label className={labelClass}>Authenticate with (optional)</label>
        <select
          value={node.data.connectionId ?? ''}
          onChange={(event) => update({ ...node, data: { ...node.data, connectionId: event.target.value || undefined } })}
          className={controlClass}
        >
          <option value="">No authentication</option>
          {authConnections.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-slate-500">
          Uses this connection&apos;s login to authorize the request — connections shared with your workspace, plus your own. Your own Authorization header always takes precedence.
        </p>
      </div>
      <InlineKeyValue
        label="Queries"
        editorKey="http.query"
        value={node.data.query}
        onChange={(query) => update({ ...node, data: { ...node.data, query } })}
        tokenWiring={tokenWiring}
      />
      <div className="grid gap-2">
        <label className={labelClass}>Body</label>
        {(node.data.bodyMode ?? 'json') === 'none' ? (
          <textarea
            rows={4}
            value={node.data.body ?? ''}
            disabled
            className={cn(controlClass, 'min-h-[100px] resize-y bg-slate-50 font-mono text-xs text-slate-400')}
            aria-label="Body disabled"
          />
        ) : (
          <TokenTextEditor
            ref={registerEditor('http.body')}
            multiline
            rows={4}
            value={node.data.body ?? ''}
            labelCtx={labelCtx}
            onFocus={focusEditor('http.body')}
            onChange={(body) => update({ ...node, data: { ...node.data, body } })}
            className={tokenControlClass}
            placeholder={(node.data.bodyMode ?? 'json') === 'text' ? 'Plain text body' : '{"text": "Use a value from Available data"}'}
            ariaLabel="Body"
          />
        )}
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Cookie</label>
        <TokenTextEditor
          ref={registerEditor('http.cookie')}
          value={node.data.cookie ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('http.cookie')}
          onChange={(cookie) => update({ ...node, data: { ...node.data, cookie: cookie || undefined } })}
          className={tokenControlClass}
          placeholder="name=value; other=value"
          ariaLabel="Cookie"
        />
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function InlineKeyValue({
  label,
  editorKey,
  value,
  onChange,
  tokenWiring,
}: {
  label: string
  editorKey: string
  value?: string
  onChange: (value: string) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const rows = parseKeyValueRows(value)
  const updateRow = (index: number, patch: Partial<KeyValueRow>) => {
    onChange(serializeKeyValueRows(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row))))
  }
  const addRow = () => onChange(serializeKeyValueRows([...rows, { key: '', value: '' }]))
  const removeRow = (index: number) => onChange(serializeKeyValueRows(rows.filter((_, rowIndex) => rowIndex !== index)))

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <label className={labelClass}>{label}</label>
        <button type="button" onClick={addRow} className="text-xs font-semibold text-blue-700 hover:text-blue-900">
          Add row
        </button>
      </div>
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={`${label}-${index}`} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
            <input
              value={row.key}
              onChange={(event) => updateRow(index, { key: event.target.value })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={controlClass}
              placeholder="Key"
            />
            <TokenTextEditor
              ref={registerEditor(`${editorKey}.${index}.value`)}
              value={row.value}
              labelCtx={labelCtx}
              onFocus={focusEditor(`${editorKey}.${index}.value`)}
              onChange={(next) => updateRow(index, { value: next })}
              className={cn(tokenControlClass, 'min-w-0')}
              placeholder="Value"
              ariaLabel={`${label} value`}
            />
            <button
              type="button"
              onClick={() => removeRow(index)}
              className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
              aria-label={`Remove ${label.toLowerCase()} row`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function ToolBody({
  node,
  toolCatalog,
  dataFields,
  update,
  showErrors,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'tool' }>
  toolCatalog: ToolCatalog
  dataFields: DataField[]
  update: (node: FlowNode) => void
  showErrors?: boolean
  tokenWiring: TokenEditorWiring
}) {
  const { connection, tool, brand, actionLabel } = selectedToolPresentation(
    toolCatalog,
    node.data.connectionId,
    node.data.toolName,
  )
  const providerGroups = groupToolConnections(toolCatalog)
  const actions = connection ? toolActionChoices(toolCatalog, connection) : []
  const selectedAction = actions.find(
    (choice) => choice.connectionId === node.data.connectionId && choice.tool.name === node.data.toolName,
  )
  return (
    <div className="space-y-4">
      {!connection ? (
        <div className="grid gap-2">
          <label className={labelClass}>Connector <span className="text-red-500">*</span></label>
          <select
            value=""
            onChange={(event) => {
              const group = providerGroups.find((entry) => entry.brand.key === event.target.value)
              const first = group?.connections.find((entry) => entry.tools.length > 0)
              update({
                ...node,
                data: {
                  ...node.data,
                  connectionId: first?.id ?? '',
                  toolName: first?.tools[0]?.name ?? '',
                  args: '{}',
                },
              })
            }}
            className={cn(controlClass, showErrors && 'border-red-400 focus:border-red-500')}
          >
            <option value="">Choose a connected app</option>
            {providerGroups.map((entry) => (
              <option key={entry.brand.key} value={entry.brand.key}>
                {entry.brand.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex min-w-0 items-center gap-3">
              <IntegrationLogo slug={brand?.slug} name={brand?.label ?? connection.name} className="h-9 w-9 rounded-lg bg-white p-1 shadow-sm" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">{brand?.label ?? connection.name}</p>
                <p className="truncate text-xs text-slate-500">{actionLabel || 'Choose an action'}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => update({ ...node, data: { ...node.data, connectionId: '', toolName: '', args: '{}' } })}
              className="shrink-0 text-xs font-semibold text-blue-700 hover:text-blue-900"
            >
              Change app
            </button>
          </div>
          <div className="grid gap-2">
            <label className={labelClass}>Action <span className="text-red-500">*</span></label>
            <select
              value={selectedAction?.key ?? ''}
              onChange={(event) => {
                const next = actions.find((choice) => choice.key === event.target.value)
                if (!next) return
                update({
                  ...node,
                  data: {
                    ...node.data,
                    connectionId: next.connectionId,
                    toolName: next.tool.name,
                    args: '{}',
                  },
                })
              }}
              className={cn(controlClass, showErrors && !node.data.toolName && 'border-red-400 focus:border-red-500')}
            >
              <option value="">Choose an action</option>
              {actions.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
          {tool && (
            <>
              {tool.description && <p className="text-sm text-slate-600">{tool.description}</p>}
              <ToolArgsEditor
                inputSchema={tool.inputSchema}
                args={node.data.args}
                onChange={(args) => update({ ...node, data: { ...node.data, args } })}
                dataFields={dataFields}
                labelCtx={tokenWiring.labelCtx}
              />
            </>
          )}
        </>
      )}
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function ConditionBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'condition' | 'filter' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const clauses = conditionClauses(node)
  const setClauses = (next: ConditionClause[]) =>
    update({
      ...node,
      data: {
        ...node.data,
        clauses: next,
        match: node.data.match ?? 'all',
        ...(node.type === 'condition' ? { left: undefined, op: undefined, right: undefined } : {}),
      },
    } as FlowNode)
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">{node.type === 'condition' ? 'Route the flow based on a rule.' : 'Continue only when this rule is true.'}</p>
      <div className="grid gap-2 sm:grid-cols-[180px_1fr] sm:items-center">
        <label className={labelClass}>Match</label>
        <select
          value={node.data.match ?? 'all'}
          onChange={(event) => {
            const match = event.target.value as 'all' | 'any'
            update({
              ...node,
              data: {
                ...node.data,
                match,
                clauses,
                ...(node.type === 'condition' ? { left: undefined, op: undefined, right: undefined } : {}),
              },
            } as FlowNode)
          }}
          className={controlClass}
          aria-label="Condition matching mode"
        >
          <option value="all">All conditions (AND)</option>
          <option value="any">Any condition (OR)</option>
        </select>
      </div>
      {clauses.map((clause, index) => (
        <div key={index} className="grid gap-2 rounded-lg border border-slate-200 p-2 sm:grid-cols-[1fr_150px_1fr_36px]">
          <TokenTextEditor
            ref={registerEditor(`clause.${index}.left`)}
            value={clause.left}
            labelCtx={labelCtx}
            onFocus={focusEditor(`clause.${index}.left`)}
            onChange={(left) => setClauses(clauses.map((entry, entryIndex) => (entryIndex === index ? { ...entry, left } : entry)))}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Field or value"
            ariaLabel={`${node.type === 'condition' ? 'Condition' : 'Filter'} ${index + 1} value`}
          />
          <select
            value={clause.op}
            onChange={(event) => setClauses(clauses.map((entry, entryIndex) => (entryIndex === index ? { ...entry, op: event.target.value as ConditionOp } : entry)))}
            className={controlClass}
            aria-label={`${node.type === 'condition' ? 'Condition' : 'Filter'} ${index + 1} operator`}
          >
            {CONDITION_OPS.map((op) => (
              <option key={op} value={op}>
                {CONDITION_OP_LABELS[op]}
              </option>
            ))}
          </select>
          <TokenTextEditor
            ref={registerEditor(`clause.${index}.right`)}
            value={clause.right}
            labelCtx={labelCtx}
            onFocus={focusEditor(`clause.${index}.right`)}
            onChange={(right) => setClauses(clauses.map((entry, entryIndex) => (entryIndex === index ? { ...entry, right } : entry)))}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Compare to"
            ariaLabel={`${node.type === 'condition' ? 'Condition' : 'Filter'} ${index + 1} comparison value`}
          />
          <button
            type="button"
            onClick={() => setClauses(clauses.filter((_, entryIndex) => entryIndex !== index))}
            disabled={clauses.length === 1}
            className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label="Remove condition"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setClauses([...clauses, { left: '', op: 'contains', right: '' }])}
        className="text-sm font-semibold text-blue-700 hover:text-blue-900"
      >
        Add condition
      </button>
    </div>
  )
}

function TransformBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'transform' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const fields = transformFields(node)
  const setFields = (next: typeof fields) => update({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Create a clean object for later steps.</p>
      {fields.map((field, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
          <input
            value={field.name}
            onChange={(event) => setFields(fields.map((entry, fieldIndex) => (fieldIndex === index ? { ...entry, name: event.target.value } : entry)))}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={controlClass}
            placeholder="Output field"
          />
          <TokenTextEditor
            ref={registerEditor(`xf.${index}`)}
            value={field.value}
            labelCtx={labelCtx}
            onFocus={focusEditor(`xf.${index}`)}
            onChange={(value) => setFields(fields.map((entry, fieldIndex) => (fieldIndex === index ? { ...entry, value } : entry)))}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Value"
            ariaLabel={`Value for field ${field.name || index + 1}`}
          />
          <button
            type="button"
            onClick={() => setFields(fields.filter((_, fieldIndex) => fieldIndex !== index))}
            className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600"
            aria-label="Remove field"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setFields([...fields, { name: '', value: '' }])} className="text-sm font-semibold text-blue-700 hover:text-blue-900">
        Add field
      </button>
    </div>
  )
}

function LoopBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'loop' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor } = tokenWiring
  const usesTriggerInput = node.data.over === '{{trigger.input}}'
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Run the steps inside this loop once for each item in a list.</p>
      <div className="grid gap-2 sm:grid-cols-[180px_1fr]">
        <select
          value={usesTriggerInput ? 'trigger' : 'custom'}
          onChange={(event) => update({ ...node, data: { ...node.data, over: event.target.value === 'trigger' ? '{{trigger.input}}' : '' } })}
          className={controlClass}
        >
          <option value="trigger">Trigger input</option>
          <option value="custom">Custom list</option>
        </select>
        {usesTriggerInput ? (
          <input value="" readOnly className={controlClass} placeholder="Uses trigger input" disabled aria-label="Items to process" />
        ) : (
          <TokenTextEditor
            ref={registerEditor('loop.over')}
            value={node.data.over}
            labelCtx={labelCtx}
            onFocus={focusEditor('loop.over')}
            onChange={(over) => update({ ...node, data: { ...node.data, over } })}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Comma-separated list, JSON array, or mapped list"
            ariaLabel="Items to process"
          />
        )}
      </div>
      <AdvancedParamsSection node={node} onChange={update} />
    </div>
  )
}

function SwitchBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'switch' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const cases = node.data.cases.length
    ? node.data.cases
    : [{ id: 'case1', left: '', op: 'contains' as ConditionOp, right: '' }]
  const setCases = (next: typeof cases) => update({ ...node, data: { ...node.data, cases: next } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Route to the first matching case, otherwise use the default path.</p>
      {cases.map((entry, index) => (
        <div key={entry.id} className="space-y-2 rounded-lg border border-slate-200 p-2">
          <div className="flex gap-2">
            <input
              value={entry.label ?? ''}
              onChange={(event) => setCases(cases.map((item, itemIndex) => (itemIndex === index ? { ...item, label: event.target.value } : item)))}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={cn(controlClass, 'min-w-0 flex-1')}
              placeholder={`Case ${index + 1} label`}
              aria-label={`Case ${index + 1} label`}
            />
            <button
              type="button"
              onClick={() => setCases(cases.filter((_, itemIndex) => itemIndex !== index))}
              disabled={cases.length === 1}
              className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-30"
              aria-label="Remove case"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_150px_1fr]">
            <TokenTextEditor
              ref={registerEditor(`sw.${index}.left`)}
              value={entry.left}
              labelCtx={labelCtx}
              onFocus={focusEditor(`sw.${index}.left`)}
              onChange={(left) => setCases(cases.map((item, itemIndex) => (itemIndex === index ? { ...item, left } : item)))}
              className={cn(tokenControlClass, 'min-w-0')}
              placeholder="Field or value"
              ariaLabel={`Case ${index + 1} value`}
            />
            <select
              value={entry.op}
              onChange={(event) => setCases(cases.map((item, itemIndex) => (itemIndex === index ? { ...item, op: event.target.value as ConditionOp } : item)))}
              className={controlClass}
              aria-label={`Case ${index + 1} operator`}
            >
              {CONDITION_OPS.map((op) => (
                <option key={op} value={op}>
                  {CONDITION_OP_LABELS[op]}
                </option>
              ))}
            </select>
            <TokenTextEditor
              ref={registerEditor(`sw.${index}.right`)}
              value={entry.right}
              labelCtx={labelCtx}
              onFocus={focusEditor(`sw.${index}.right`)}
              onChange={(right) => setCases(cases.map((item, itemIndex) => (itemIndex === index ? { ...item, right } : item)))}
              className={cn(tokenControlClass, 'min-w-0')}
              placeholder="Compare to"
              ariaLabel={`Case ${index + 1} comparison value`}
            />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          setCases([
            ...cases,
            {
              id: `case${cases.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
              left: '',
              op: 'contains',
              right: '',
            },
          ])
        }
        className="text-sm font-semibold text-blue-700 hover:text-blue-900"
      >
        Add case
      </button>
    </div>
  )
}

function StopBody({ node, update }: { node: Extract<FlowNode, { type: 'stop' }>; update: (node: FlowNode) => void }) {
  return (
    <div className="grid gap-2">
      <label className={labelClass}>Message</label>
      <input
        value={node.data.reason ?? ''}
        onChange={(event) => update({ ...node, data: { ...node.data, reason: event.target.value } })}
        className={controlClass}
        placeholder="Optional reason shown when this flow stops"
      />
    </div>
  )
}

function VariableBody({
  node,
  update,
  tokenWiring,
  variableNames,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'variable' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  variableNames?: string[]
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const isInitialize = node.data.op === 'initialize'
  const currentName = node.data.name.trim()
  // Mutation ops pick from variables initialized earlier; keep a name that is
  // not in that list selectable (it may live in a sibling branch).
  const nameOptions = [...(variableNames ?? []), ...(currentName && !(variableNames ?? []).includes(currentName) ? [currentName] : [])]
  const setOp = (op: VariableOp) =>
    update({ ...node, data: { ...node.data, op, varType: op === 'initialize' ? node.data.varType ?? 'string' : undefined } })
  const nameInvalid = Boolean(showErrors && !currentName)
  const valueInvalid = Boolean(showErrors && !variableValueOptional(node.data.op) && !node.data.value?.trim())
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Operation</label>
        <select value={node.data.op} onChange={(event) => setOp(event.target.value as VariableOp)} className={controlClass}>
          {VARIABLE_OPS.map((op) => (
            <option key={op} value={op}>
              {VARIABLE_OP_LABELS[op]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Name <span className="text-red-500">*</span></label>
        {isInitialize || nameOptions.length === 0 ? (
          <input
            value={node.data.name}
            onChange={(event) => update({ ...node, data: { ...node.data, name: event.target.value } })}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={cn(controlClass, nameInvalid && 'border-red-400 focus:border-red-500')}
            placeholder="Enter variable name"
            aria-label="Variable name"
          />
        ) : (
          <select
            value={currentName}
            onChange={(event) => update({ ...node, data: { ...node.data, name: event.target.value } })}
            className={cn(controlClass, nameInvalid && 'border-red-400 focus:border-red-500')}
            aria-label="Variable name"
          >
            <option value="">Choose a variable</option>
            {nameOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {!isInitialize && nameOptions.length === 0 && (
          <p className="text-xs text-slate-500">No variables are initialized earlier in this flow — add an Initialize variable step first, or type the name it will use.</p>
        )}
      </div>
      {isInitialize && (
        <div className="grid gap-2">
          <label className={labelClass}>Type <span className="text-red-500">*</span></label>
          <select
            value={node.data.varType ?? 'string'}
            onChange={(event) => update({ ...node, data: { ...node.data, varType: event.target.value as VariableType } })}
            className={controlClass}
          >
            {VARIABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {VARIABLE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="grid gap-2">
        <label className={labelClass}>
          Value {variableValueOptional(node.data.op) ? <span className="font-normal normal-case text-slate-400">(optional)</span> : <span className="text-red-500">*</span>}
        </label>
        <TokenTextEditor
          ref={registerEditor('var.value')}
          value={node.data.value ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('var.value')}
          onChange={(value) => update({ ...node, data: { ...node.data, value } })}
          invalid={valueInvalid}
          className={cn(tokenControlBase, valueInvalid ? 'focus:border-red-500' : 'border-slate-300')}
          placeholder={VARIABLE_VALUE_PLACEHOLDER[node.data.op]}
          ariaLabel="Variable value"
        />
      </div>
    </div>
  )
}

function DataBody({
  node,
  update,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'data' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const op = node.data.op
  const setOp = (next: DataOp) => {
    // Ops with required list config start with one empty row so the editor
    // opens ready to fill in.
    const clauses = next === 'filterArray' && !(node.data.clauses ?? []).length ? [{ left: '', op: 'contains' as ConditionOp, right: '' }] : node.data.clauses
    const fields = next === 'select' && !(node.data.fields ?? []).length ? [{ name: '', value: '' }] : node.data.fields
    update({ ...node, data: { ...node.data, op: next, clauses, fields } })
  }
  const inputInvalid = Boolean(showErrors && !node.data.input?.trim())
  const clauses = node.data.clauses ?? []
  const fields = node.data.fields ?? []
  const setClauses = (next: ConditionClause[]) => update({ ...node, data: { ...node.data, clauses: next } })
  const setFields = (next: { name: string; value: string }[]) => update({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Operation</label>
        <select value={op} onChange={(event) => setOp(event.target.value as DataOp)} className={controlClass}>
          {DATA_OPS.map((entry) => (
            <option key={entry} value={entry}>
              {DATA_OP_LABELS[entry]}
            </option>
          ))}
        </select>
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Input <span className="text-red-500">*</span></label>
        <TokenTextEditor
          ref={registerEditor('data.input')}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          onFocus={focusEditor('data.input')}
          onChange={(input) => update({ ...node, data: { ...node.data, input } })}
          invalid={inputInvalid}
          className={cn(tokenControlBase, inputInvalid ? 'focus:border-red-500' : 'border-slate-300')}
          placeholder={DATA_OP_INPUT_PLACEHOLDER[op]}
          ariaLabel="Input"
        />
      </div>
      {(op === 'join' || op === 'split') && (
        <div className="grid gap-2">
          <label className={labelClass}>{op === 'join' ? 'Join with' : 'Split at'} <span className="font-normal normal-case text-slate-400">(optional)</span></label>
          <input
            value={node.data.separator ?? ''}
            onChange={(event) => update({ ...node, data: { ...node.data, separator: event.target.value || undefined } })}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={controlClass}
            placeholder="Defaults to a comma"
            aria-label={op === 'join' ? 'Join with' : 'Split at'}
          />
        </div>
      )}
      {op === 'replace' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-2">
            <label className={labelClass}>Find <span className="text-red-500">*</span></label>
            <input
              value={node.data.find ?? ''}
              onChange={(event) => update({ ...node, data: { ...node.data, find: event.target.value || undefined } })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={cn(controlClass, showErrors && !node.data.find && 'border-red-400 focus:border-red-500')}
              placeholder="Text to find"
              aria-label="Find"
            />
          </div>
          <div className="grid gap-2">
            <label className={labelClass}>Replace with</label>
            <input
              value={node.data.replaceWith ?? ''}
              onChange={(event) => update({ ...node, data: { ...node.data, replaceWith: event.target.value || undefined } })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={controlClass}
              placeholder="Leave empty to remove it"
              aria-label="Replace with"
            />
          </div>
        </div>
      )}
      {op === 'getItem' && (
        <div className="grid gap-2">
          <label className={labelClass}>Position</label>
          <input
            value={node.data.index ?? ''}
            onChange={(event) => update({ ...node, data: { ...node.data, index: event.target.value || undefined } })}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={controlClass}
            placeholder="0 is the first item; -1 is the last"
            aria-label="Position"
          />
        </div>
      )}
      {op === 'trim' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-2">
            <label className={labelClass}>Items to remove</label>
            <input
              value={node.data.count ?? ''}
              onChange={(event) => update({ ...node, data: { ...node.data, count: event.target.value || undefined } })}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={controlClass}
              placeholder="Defaults to 1"
              aria-label="Items to remove"
            />
          </div>
          <div className="grid gap-2">
            <label className={labelClass}>From</label>
            <select
              value={node.data.fromEnd ? 'end' : 'start'}
              onChange={(event) => update({ ...node, data: { ...node.data, fromEnd: event.target.value === 'end' ? true : undefined } })}
              className={controlClass}
              aria-label="Trim from"
            >
              <option value="start">The start</option>
              <option value="end">The end</option>
            </select>
          </div>
        </div>
      )}
      {op === 'parseJson' && (
        <div className="grid gap-2">
          <label className={labelClass}>Schema <span className="font-normal normal-case text-slate-400">(optional)</span></label>
          <textarea
            rows={4}
            value={node.data.schema ?? ''}
            onChange={(event) => update({ ...node, data: { ...node.data, schema: event.target.value || undefined } })}
            onFocus={blockActive}
            onBlur={unblockActive}
            className={cn(controlClass, 'h-auto resize-y py-2 font-mono text-xs')}
            placeholder="A JSON Schema describing the parsed shape"
            aria-label="Schema"
          />
          <p className="text-xs text-slate-500">Optional — stored for reference.</p>
        </div>
      )}
      {op === 'filterArray' && (
        <div className="grid gap-2">
          <label className={labelClass}>Conditions <span className="text-red-500">*</span></label>
          {(clauses.length ? clauses : [{ left: '', op: 'contains' as ConditionOp, right: '' }]).map((clause, index, list) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_130px_1fr_36px]">
              <TokenTextEditor
                ref={registerEditor(`data.clause.${index}.left`)}
                value={clause.left}
                labelCtx={labelCtx}
                onFocus={focusEditor(`data.clause.${index}.left`)}
                onChange={(left) => setClauses(list.map((entry, j) => (j === index ? { ...entry, left } : entry)))}
                className={cn(tokenControlClass, 'min-w-0')}
                placeholder="Item field to check"
                ariaLabel={`Condition ${index + 1} value`}
              />
              <select
                value={clause.op}
                onChange={(event) => setClauses(list.map((entry, j) => (j === index ? { ...entry, op: event.target.value as ConditionOp } : entry)))}
                className={controlClass}
              >
                {CONDITION_OPS.map((entry) => (
                  <option key={entry} value={entry}>
                    {CONDITION_OP_LABELS[entry]}
                  </option>
                ))}
              </select>
              <TokenTextEditor
                ref={registerEditor(`data.clause.${index}.right`)}
                value={clause.right}
                labelCtx={labelCtx}
                onFocus={focusEditor(`data.clause.${index}.right`)}
                onChange={(right) => setClauses(list.map((entry, j) => (j === index ? { ...entry, right } : entry)))}
                className={cn(tokenControlClass, 'min-w-0')}
                placeholder="Compare to"
                ariaLabel={`Condition ${index + 1} comparison value`}
              />
              <button
                type="button"
                onClick={() => setClauses(list.filter((_, j) => j !== index))}
                disabled={list.length === 1}
                className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Remove condition"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setClauses([...(clauses.length ? clauses : [{ left: '', op: 'contains' as ConditionOp, right: '' }]), { left: '', op: 'contains', right: '' }])}
            className="text-left text-sm font-semibold text-blue-700 hover:text-blue-900"
          >
            Add condition
          </button>
        </div>
      )}
      {op === 'select' && (
        <div className="grid gap-2">
          <label className={labelClass}>Fields <span className="text-red-500">*</span></label>
          {(fields.length ? fields : [{ name: '', value: '' }]).map((field, index, list) => (
            <div key={index} className="grid gap-2 sm:grid-cols-[1fr_1fr_36px]">
              <input
                value={field.name}
                onChange={(event) => setFields(list.map((entry, j) => (j === index ? { ...entry, name: event.target.value } : entry)))}
                onFocus={blockActive}
                onBlur={unblockActive}
                className={controlClass}
                placeholder="Output field"
              />
              <TokenTextEditor
                ref={registerEditor(`data.field.${index}.value`)}
                value={field.value}
                labelCtx={labelCtx}
                onFocus={focusEditor(`data.field.${index}.value`)}
                onChange={(value) => setFields(list.map((entry, j) => (j === index ? { ...entry, value } : entry)))}
                className={cn(tokenControlClass, 'min-w-0')}
                placeholder="Value for this field"
                ariaLabel={`Value for field ${field.name || index + 1}`}
              />
              <button
                type="button"
                onClick={() => setFields(list.filter((_, j) => j !== index))}
                disabled={list.length === 1}
                className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-30"
                aria-label="Remove field"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFields([...(fields.length ? fields : [{ name: '', value: '' }]), { name: '', value: '' }])}
            className="text-left text-sm font-semibold text-blue-700 hover:text-blue-900"
          >
            Add field
          </button>
        </div>
      )}
      <p className="text-xs text-slate-500">{DATA_OP_HELPER[op]}</p>
    </div>
  )
}

function HumanReviewBody({
  node,
  members,
  update,
  tokenWiring,
  showErrors,
}: {
  node: Extract<FlowNode, { type: 'humanReview' }>
  members?: OrgMember[]
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
  showErrors?: boolean
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const messageInvalid = Boolean(showErrors && !node.data.message.trim())
  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <label className={labelClass}>Message <span className="text-red-500">*</span></label>
        <TokenTextEditor
          ref={registerEditor('hr.message')}
          multiline
          rows={4}
          value={node.data.message}
          labelCtx={labelCtx}
          onFocus={focusEditor('hr.message')}
          onChange={(message) => update({ ...node, data: { ...node.data, message } })}
          invalid={messageInvalid}
          className={cn(tokenControlBase, messageInvalid ? 'focus:border-red-500' : 'border-slate-300')}
          placeholder="What should the person be asked? Their reply becomes this step's output."
          ariaLabel="Message"
        />
      </div>
      <div className="grid gap-2">
        <label className={labelClass}>Assign to (optional)</label>
        {/* Empty value = engine default (the run owner is asked). A stored
            assignee missing from the roster (departed member) stays selected
            as "Former member" so opening the editor never rewrites data. */}
        <select
          value={node.data.assigneeUserId ?? ''}
          onChange={(event) => update({ ...node, data: { ...node.data, assigneeUserId: event.target.value || undefined } })}
          onFocus={blockActive}
          onBlur={unblockActive}
          className={controlClass}
        >
          <option value="">Flow owner (default)</option>
          {(members ?? []).map((member) => (
            <option key={member.id} value={member.id}>
              {orgMemberLabel(member)}
            </option>
          ))}
          {node.data.assigneeUserId && !(members ?? []).some((member) => member.id === node.data.assigneeUserId) && (
            <option value={node.data.assigneeUserId}>Former member</option>
          )}
        </select>
        <p className="text-xs text-slate-500">They&apos;ll be notified when the flow pauses here.</p>
      </div>
    </div>
  )
}

type OutputRow = { name: string; value: string; type?: 'text' | 'list' | 'any' }
const OUTPUT_VALUE_TYPES: { value: 'text' | 'list' | 'any'; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'text', label: 'Text' },
  { value: 'list', label: 'List' },
]

function OutputBody({
  node,
  update,
  tokenWiring,
}: {
  node: Extract<FlowNode, { type: 'output' }>
  update: (node: FlowNode) => void
  tokenWiring: TokenEditorWiring
}) {
  const { labelCtx, registerEditor, focusEditor, blockActive, unblockActive } = tokenWiring
  const outputs: OutputRow[] = node.data.outputs.length ? node.data.outputs : [{ name: 'output', value: '', type: 'any' }]
  const setOutputs = (next: OutputRow[]) => update({ ...node, data: { ...node.data, outputs: next } })
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">Return one or more named results to whatever called this flow.</p>
      {outputs.map((row, index) => (
        <div key={index} className="grid gap-2">
          <div className="grid gap-2 sm:grid-cols-[1fr_130px_36px]">
            <input
              value={row.name}
              onChange={(event) => setOutputs(outputs.map((r, j) => (j === index ? { ...r, name: event.target.value } : r)))}
              onFocus={blockActive}
              onBlur={unblockActive}
              className={controlClass}
              placeholder="resultName"
              aria-label="Output name"
            />
            <select
              value={row.type ?? 'any'}
              onChange={(event) => setOutputs(outputs.map((r, j) => (j === index ? { ...r, type: event.target.value as OutputRow['type'] } : r)))}
              className={controlClass}
              aria-label="Output type"
            >
              {OUTPUT_VALUE_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setOutputs(outputs.filter((_, j) => j !== index))}
              disabled={outputs.length === 1}
              className="flex h-10 w-10 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600 disabled:pointer-events-none disabled:opacity-30"
              aria-label="Remove output"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          <TokenTextEditor
            ref={registerEditor(`out.${index}.value`)}
            value={row.value}
            labelCtx={labelCtx}
            onFocus={focusEditor(`out.${index}.value`)}
            onChange={(value) => setOutputs(outputs.map((r, j) => (j === index ? { ...r, value } : r)))}
            className={cn(tokenControlClass, 'min-w-0')}
            placeholder="Value to return for this result"
            ariaLabel={`Value for output ${row.name || index + 1}`}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => setOutputs([...outputs, { name: '', value: '', type: 'any' }])}
        className="text-left text-sm font-semibold text-blue-700 hover:text-blue-900"
      >
        Add output
      </button>
    </div>
  )
}
