'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Trash2, Plus, Copy, Database, Settings2, Braces, ChevronLeft, ChevronRight, KeyRound, TerminalSquare, Play, Pin } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { AI_OPS, AI_OP_LABELS, CONDITION_OPS, UNARY_CONDITION_OPS, CONDITION_OP_LABELS, DATA_OPS, FIELD_TYPES, VARIABLE_OPS, VARIABLE_OP_LABELS, VARIABLE_TYPES, VARIABLE_TYPE_LABELS, type AiOp, type FlowNode, type ConditionOp, type ConditionClause, type DataOp, type FieldType, type OutputField, type TriggerInputField, type VariableOp, type VariableType } from '@/lib/flows/graph'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { DATA_OP_HELPER, DATA_OP_INPUT_PLACEHOLDER, SUMMARIZE_OP_LABELS, VARIABLE_VALUE_PLACEHOLDER, variableValueOptional } from '@/lib/flows/step-copy'
import { useDismissOnOutsidePointer } from '@/hooks/use-dismiss-on-outside-pointer'
import { DataTree } from '@/components/flows/data-tree'
import { ToolArgsEditor } from '@/components/flows/tool-args-editor'
import { type DataField } from '@/lib/flows/datatree'
import { AdvancedParamsSection } from '@/components/flows/advanced-params'
import { CodeEditor } from '@/components/flows/code-editor'
import { CodeAssist } from '@/components/flows/code-assist'
import { TokenTextEditor, type TokenTextEditorHandle } from '@/components/flows/token-text-editor'
import type { TokenLabelContext } from '@/lib/flows/token-text'
import type { FlowContext } from '@/features/flows/context'
import { cn } from '@/lib/utils'
import { TriggerEditor, type TriggerData } from './trigger-editor'
import { useWorkspaceFlows } from './use-workspace-flows'
import { IntegrationLogo } from '@/components/integrations/integration-logo'
import { groupToolConnections, selectedToolPresentation, toolActionChoices } from '@/lib/flows/tool-presentation'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { Switch } from '@/components/ui/switch'
import {
  HTTP_AUTH_OPTIONS,
  HttpCredentialDialog,
  type HttpAuthOption,
  type HttpCredentialSummary,
} from '@/components/flows/http-credential-dialog'
import { ImportCurlDialog } from '@/components/flows/import-curl-dialog'

export type { TriggerData }

type EditableType = Extract<FlowNode['type'], 'agent' | 'ai' | 'subflow' | 'knowledge' | 'code' | 'condition' | 'loop' | 'parallel' | 'stop' | 'tool' | 'http' | 'transform' | 'filter' | 'switch' | 'variable' | 'data' | 'humanReview' | 'output' | 'join'>
const NODE_TYPES: { value: EditableType; label: string }[] = [
  { value: 'agent', label: 'Run agent' },
  { value: 'ai', label: 'AI operation' },
  { value: 'subflow', label: 'Run a flow' },
  { value: 'knowledge', label: 'Search knowledge' },
  { value: 'code', label: 'Code' },
  { value: 'tool', label: 'Tool call' },
  { value: 'http', label: 'HTTP request' },
  { value: 'transform', label: 'Set fields' },
  { value: 'data', label: 'Data operation' },
  { value: 'variable', label: 'Variable' },
  { value: 'humanReview', label: 'Request information' },
  { value: 'condition', label: 'If / else' },
  { value: 'switch', label: 'Switch' },
  { value: 'filter', label: 'Filter' },
  { value: 'loop', label: 'For each' },
  { value: 'parallel', label: 'Parallel' },
  { value: 'output', label: 'Output' },
  { value: 'join', label: 'Join paths' },
  { value: 'stop', label: 'Stop' },
]

export type ToolCatalog = { id: string; name: string; tools: { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown }[]; toolsError?: string }[]

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
// Textareas: comfortable default height, user-resizable vertically.
const areaClass = `${fieldClass} min-h-[120px] resize-y`
const smallField =
  'rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/** Drop an empty AI-optimize config to undefined so a cleared form persists nothing. */
function cleanOptimize(next: { dataPath?: string; fields?: string[]; maxItems?: number }): { dataPath?: string; fields?: string[]; maxItems?: number } | undefined {
  const fields = (next.fields ?? []).filter((f) => f.trim())
  const cleaned = { ...next, fields: fields.length ? fields : undefined }
  return cleaned.dataPath || cleaned.fields || cleaned.maxItems ? cleaned : undefined
}

/** Node types that support the per-item fan-out modifier (see perItemSchema). */
const PER_ITEM_TYPES: ReadonlySet<FlowNode['type']> = new Set(['agent', 'tool', 'http', 'ai', 'code', 'subflow', 'data', 'transform', 'knowledge'])

type PerItemConfigLike = { over: string; itemError?: 'fail' | 'skip' | 'collect'; concurrency?: number }

/**
 * "Run once per item" control — the list-aware step contract surfaced in the
 * drawer. When on, the step fans out over `over` (a list picked from the data
 * menu), exposing {{item}} in this step's own fields, and collects the per-item
 * outputs into a list. Rendered once for every per-item-capable node type.
 */
function PerItemSection({
  node,
  onChange,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
}: {
  node: FlowNode
  onChange: (node: FlowNode) => void
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  insertToken: (token: string) => void
}) {
  const perItem = (node.data as { perItem?: PerItemConfigLike }).perItem
  const enabled = Boolean(perItem)
  const patch = (next: PerItemConfigLike | undefined) => onChange({ ...node, data: { ...node.data, perItem: next } } as FlowNode)
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <label className={labelClass}>Run this step</label>
      <select
        className={fieldClass}
        value={enabled ? 'each' : 'once'}
        onChange={(e) => patch(e.target.value === 'each' ? { over: perItem?.over ?? '', itemError: perItem?.itemError, concurrency: perItem?.concurrency } : undefined)}
      >
        <option value="once">Once</option>
        <option value="each">Once for each item in a list</option>
      </select>
      {enabled && perItem && (
        <div className="mt-3 space-y-3">
          <div>
            <label className={labelClass}>For each item in</label>
            <TokenTextEditor
              ref={registerEditor('perItem.over')}
              value={perItem.over}
              labelCtx={labelCtx}
              placeholder="Choose a list from the available data below"
              onFocus={focusEditor('perItem.over')}
              onChange={(over) => patch({ ...perItem, over })}
              ariaLabel="For each item in"
            />
            <div className="mt-2">
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">This step runs once per item; use {'{{item}}'} in its fields. Outputs are collected into a list.</p>
          </div>
          <div>
            <label className={labelClass}>If an item fails</label>
            <select
              className={fieldClass}
              value={perItem.itemError ?? 'fail'}
              onChange={(e) => patch({ ...perItem, itemError: e.target.value === 'fail' ? undefined : (e.target.value as 'skip' | 'collect') })}
            >
              <option value="fail">Stop the whole step</option>
              <option value="skip">Skip that item, keep the rest</option>
              <option value="collect">Keep going, record the error in its place</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>At a time</label>
            <input
              type="number"
              min={1}
              max={20}
              className={fieldClass}
              value={perItem.concurrency ?? 1}
              onChange={(e) => patch({ ...perItem, concurrency: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function clausesOf(data: { clauses?: ConditionClause[]; left?: string; op?: ConditionOp; right?: string }): ConditionClause[] {
  if (data.clauses && data.clauses.length) return data.clauses
  if (data.left !== undefined || data.right !== undefined)
    return [{ left: data.left ?? '', op: data.op ?? 'contains', right: data.right ?? '' }]
  return [{ left: '', op: 'contains', right: '' }]
}

type KeyValueRow = { key: string; value: string }

function parseKeyValueRows(value: string | undefined): { rows: KeyValueRow[]; invalid: boolean } {
  if (!value?.trim()) return { rows: [{ key: '', value: '' }], invalid: false }
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { rows: [{ key: '', value }], invalid: true }
    const rows = Object.entries(parsed).map(([key, item]) => ({
      key,
      value: typeof item === 'string' ? item : JSON.stringify(item),
    }))
    return { rows: rows.length ? rows : [{ key: '', value: '' }], invalid: false }
  } catch {
    return { rows: [{ key: '', value }], invalid: true }
  }
}

function parseTypedValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (!/^(?:true|false|null|-?\d|\{|\[|")/.test(trimmed)) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function serializeKeyValueRows(rows: KeyValueRow[]): string | undefined {
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = parseTypedValue(row.value)
  }
  return Object.keys(out).length ? JSON.stringify(out, null, 2) : undefined
}

function KeyValueJsonEditor({
  label,
  value,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  helper,
  labelCtx,
  editorKey,
  registerEditor,
  focusEditor,
  blockActive,
  unblockActive,
}: {
  label: string
  value: string | undefined
  onChange: (value: string | undefined) => void
  keyPlaceholder: string
  valuePlaceholder: string
  helper: string
  labelCtx: TokenLabelContext
  editorKey: string
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  blockActive: () => void
  unblockActive: () => void
}) {
  const parsed = parseKeyValueRows(value)
  const [entryMode, setEntryMode] = useState<'fields' | 'json'>(parsed.invalid ? 'json' : 'fields')

  if (entryMode === 'json' || parsed.invalid) {
    return (
      <div className="space-y-2">
        <div className="flex items-end justify-between gap-3">
          <label className={labelClass}>{label}</label>
          <select
            className={`${smallField} w-auto min-w-40`}
            value="json"
            onChange={(event) => setEntryMode(event.target.value as 'fields' | 'json')}
            aria-label={`${label} input mode`}
          >
            <option value="fields">Using fields below</option>
            <option value="json">Using JSON</option>
          </select>
        </div>
        <TokenTextEditor
          ref={registerEditor(`${editorKey}.json`)}
          multiline
          rows={5}
          className="font-mono text-xs"
          value={value ?? ''}
          labelCtx={labelCtx}
          placeholder={'{"name": "value"}'}
          onFocus={focusEditor(`${editorKey}.json`)}
          onChange={(next) => onChange(next || undefined)}
          ariaLabel={`${label} JSON`}
        />
        <p className={`text-[11px] ${parsed.invalid ? 'text-amber-600' : 'text-muted-foreground'}`}>
          {parsed.invalid ? 'Enter a valid JSON object before switching back to fields.' : helper}
        </p>
      </div>
    )
  }

  const savedRows = parsed.rows.filter((row) => row.key || row.value)
  const displayRows = [...savedRows, { key: '', value: '' }]
  const setRow = (index: number, patch: Partial<KeyValueRow>) => {
    const next = [...savedRows]
    const current = next[index] ?? { key: '', value: '' }
    next[index] = {
      key: patch.key ?? current.key,
      value: patch.value ?? current.value,
    }
    onChange(serializeKeyValueRows(next))
  }
  const removeRow = (index: number) => {
    onChange(serializeKeyValueRows(savedRows.filter((_row, rowIndex) => rowIndex !== index)))
  }

  return (
    <div>
      <div className="flex items-end justify-between gap-3">
        <label className={labelClass}>{label}</label>
        <select
          className={`${smallField} w-auto min-w-40`}
          value={entryMode}
          onChange={(event) => setEntryMode(event.target.value as 'fields' | 'json')}
          aria-label={`${label} input mode`}
        >
          <option value="fields">Using fields below</option>
          <option value="json">Using JSON</option>
        </select>
      </div>
      <div className="space-y-2 rounded-xl border border-border bg-background/40 p-2">
        {displayRows.map((row, index) => {
          const saved = index < savedRows.length
          return (
            <div key={index} className="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto] gap-2">
              <input
                className={smallField}
                value={row.key}
                placeholder={keyPlaceholder}
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => setRow(index, { key: e.target.value })}
              />
              <TokenTextEditor
                ref={registerEditor(`${editorKey}.${index}.value`)}
                className="min-w-0 px-2 py-1.5"
                value={row.value}
                placeholder={valuePlaceholder}
                labelCtx={labelCtx}
                onFocus={focusEditor(`${editorKey}.${index}.value`)}
                onChange={(next) => setRow(index, { value: next })}
                ariaLabel={`${label} value`}
              />
              <button
                type="button"
                aria-label={`Remove ${label.toLowerCase()} row`}
                disabled={!saved}
                onClick={() => removeRow(index)}
                className="rounded-lg border border-border px-2 text-muted-foreground hover:bg-muted disabled:pointer-events-none disabled:opacity-30"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{helper}</p>
    </div>
  )
}

function AddNestedStepMenu({
  label,
  onPick,
}: {
  label: string
  onPick: (type: EditableType) => void
}) {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // The drawer sits inside a backdrop-blur overlay, which is a containing block
  // for fixed children — the backdrop this used to render stopped at the
  // overlay's padding instead of the viewport edge.
  useDismissOnOutsidePointer(open, () => setOpen(false), [menuRef])
  return (
    <div className="relative" ref={menuRef}>
      <Button variant="outline" size="sm" className="w-full" onClick={() => setOpen((value) => !value)}>
        <Plus className="mr-1.5 h-4 w-4" /> {label}
      </Button>
      {open && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded-lg border border-border bg-card p-1 shadow-popover">
            {NODE_TYPES.map((type) => (
              <button
                key={type.value}
                type="button"
                onClick={() => {
                  setOpen(false)
                  onPick(type.value)
                }}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
              >
                {type.label}
              </button>
            ))}
          </div>
      )}
    </div>
  )
}

// Sentinel for activeFieldRef: a non-token input (raw-JSON textarea, KV key
// names, label/notes, field-name inputs, …) is focused, so datatree inserts
// must be a no-op — falling back to the step's primary field would silently
// write to a field the user is not editing.
const NON_TOKEN_FOCUSED = 'non-token-focused'

// Where a datatree click lands when no chip editor has been focused yet: the
// step type's primary token field (mirrors the old default-accessor behavior).
const DEFAULT_EDITOR_KEYS: Partial<Record<FlowNode['type'], string>> = {
  agent: 'agent.input',
  ai: 'ai.instructions',
  knowledge: 'knowledge.query',
  loop: 'loop.over',
  http: 'http.body',
  subflow: 'subflow.input',
  transform: 'xf.0',
  condition: 'cond.0.left',
  filter: 'filt.0.left',
  switch: 'sw.0.left',
  variable: 'var.value',
  data: 'data.input',
  humanReview: 'hr.message',
  output: 'out.0.value',
  code: 'code.input',
}

/** Workspace member as returned by GET /api/organizations/members. */
export type OrgMember = { id: string; name: string | null; email: string | null }

export function orgMemberLabel(member: OrgMember): string {
  return member.name?.trim() || member.email?.trim() || 'Member'
}

function ToolConfigurationSection({
  node,
  toolCatalog,
  dataFields,
  labelCtx,
  onChange,
}: {
  node: Extract<FlowNode, { type: 'tool' }>
  toolCatalog: ToolCatalog
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  onChange: (node: FlowNode) => void
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
    <div className="space-y-3">
      {!connection ? (
        <div>
          <label className={labelClass}>Connector</label>
          <select
            className={fieldClass}
            value=""
            onChange={(event) => {
              const group = providerGroups.find((entry) => entry.brand.key === event.target.value)
              const first = group?.connections.find((entry) => entry.tools.length > 0)
              onChange({
                ...node,
                data: {
                  ...node.data,
                  connectionId: first?.id ?? '',
                  toolName: first?.tools[0]?.name ?? '',
                  args: '{}',
                },
              })
            }}
          >
            <option value="">Choose a connected app…</option>
            {providerGroups.map((entry) => (
              <option key={entry.brand.key} value={entry.brand.key}>
                {entry.brand.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/50 p-3">
            <div className="flex min-w-0 items-center gap-3">
              <IntegrationLogo slug={brand?.slug} name={brand?.label ?? connection.name} className="h-9 w-9 rounded-lg bg-white p-1 shadow-sm" />
              <div className="min-w-0">
                <p className="text-sm font-semibold">{brand?.label ?? connection.name}</p>
                <p className="truncate text-xs text-muted-foreground">{actionLabel || 'Choose an action'}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onChange({ ...node, data: { ...node.data, connectionId: '', toolName: '', args: '{}' } })}
              className="shrink-0 text-xs font-semibold text-indigo-600 hover:text-indigo-700"
            >
              Change app
            </button>
          </div>
          <div>
            <label className={labelClass}>Action</label>
            <select
              className={fieldClass}
              value={selectedAction?.key ?? ''}
              onChange={(event) => {
                const next = actions.find((choice) => choice.key === event.target.value)
                if (!next) return
                onChange({
                  ...node,
                  data: {
                    ...node.data,
                    connectionId: next.connectionId,
                    toolName: next.tool.name,
                    args: '{}',
                  },
                })
              }}
            >
              <option value="">Choose an action…</option>
              {actions.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
          {tool && (
            <>
              {tool.description && <p className="text-xs text-muted-foreground">{tool.description}</p>}
              <ToolArgsEditor
                inputSchema={tool.inputSchema}
                args={node.data.args}
                onChange={(args) => onChange({ ...node, data: { ...node.data, args } })}
                dataFields={dataFields}
                labelCtx={labelCtx}
                connectionId={node.data.connectionId}
                pickerTools={Array.from(new Set(actions.map((entry) => entry.tool.name)))}
              />
            </>
          )}
        </>
      )}
      <AdvancedParamsSection node={node} onChange={onChange} defaultOpen />
      <p className="text-xs text-muted-foreground">Runs this exact connected action with the configured inputs.</p>
    </div>
  )
}

export function StepDrawer({
  node,
  flowId,
  agents,
  members,
  toolCatalog,
  dataFields,
  labelCtx,
  previewCtx,
  variableNames,
  issues,
  published,
  onFlowPersisted,
  rawInput,
  rawOutput,
  rawLogs,
  mockData,
  layout = 'drawer',
  navigation,
  onNavigate,
  onChange,
  onAddStep,
  onDuplicate,
  onDelete,
  onClose,
  onExecuteStep,
  onExecuteOnly,
  onExecutePrevious,
  onSetMockData,
}: {
  node: FlowNode
  flowId: string
  agents: { id: string; title: string }[]
  members?: OrgMember[]
  toolCatalog: ToolCatalog
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  previewCtx?: FlowContext
  variableNames?: string[]
  issues?: { level: 'error' | 'warning'; message: string }[]
  published?: boolean
  onFlowPersisted?: (updatedAt: string) => void
  rawInput?: unknown
  rawOutput?: unknown
  rawLogs?: string[]
  mockData?: unknown
  layout?: 'drawer' | 'workspace'
  /**
   * Where this step sits in the flow, so the header can walk to its neighbours.
   * Testing a flow means opening each step in turn; without this the only way
   * between two steps is close → find on canvas → reopen.
   */
  navigation?: {
    /** 1-based position, for the "3 / 8" readout. */
    index: number
    total: number
    previous?: { id: string; label: string }
    next?: { id: string; label: string }
  }
  onNavigate?: (nodeId: string) => void
  onChange: (node: FlowNode) => void
  onChangeType?: (type: EditableType) => void
  onExecuteStep?: () => void
  /** Run ONLY this step, replaying the last run's upstream outputs. */
  onExecuteOnly?: () => void
  onExecutePrevious?: () => void
  onSetMockData?: (value: unknown | undefined) => void
  onAddStep?: (type: EditableType) => void
  onDuplicate?: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const isWorkspace = layout === 'workspace'
  const [httpCredentials, setHttpCredentials] = useState<HttpCredentialSummary[]>([])
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false)
  const [newCredentialType, setNewCredentialType] = useState<HttpAuthOption>('basic')
  const [curlDialogOpen, setCurlDialogOpen] = useState(false)
  const [reverifyingCredential, setReverifyingCredential] = useState(false)
  // Editable draft of the pinned mock JSON. Reset from the graph's pinData when
  // the selected node changes; in-node edits are owned by the textarea/handlers.
  const [mockDraft, setMockDraft] = useState('')
  useEffect(() => {
    setMockDraft(mockData === undefined ? '' : JSON.stringify(mockData, null, 2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  // HTTP auth: n8n's three-way selector (None / Predefined / Generic). The mode
  // is derived from what the node already binds, with a local override so a user
  // can pick "Generic" and see the auth-type sub-select before a credential
  // exists. Reset when the selected node changes.
  const [httpAuthMode, setHttpAuthMode] = useState<'none' | 'predefined' | 'generic'>('none')
  useEffect(() => {
    if (node.type !== 'http') return
    setHttpAuthMode(node.data.connectionId ? 'predefined' : node.data.credentialId ? 'generic' : 'none')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])
  // Predefined credentials reuse connected integrations. Only MCP-plane
  // connections carry a token the HTTP executor can inject, so filter to those.
  const predefinedConnections = useMemo(
    () => groupToolConnections(toolCatalog)
      .flatMap((group) => group.connections)
      .filter((connection) => parseFlowToolConnectionId(connection.id).plane === 'mcp'),
    [toolCatalog],
  )
  const isTrigger = node.type === 'trigger'
  const trigger = ((node.type === 'trigger' ? node.data.trigger : undefined) as TriggerData | undefined) ?? { type: 'manual' }
  // Chip-editor handles keyed by field, so a datatree click inserts a token
  // chip at the caret of the last-focused editor. Keys are looked up live at
  // insert time — an unmounted editor's map slot is null, so inserts fall back
  // to the step's default field instead of vanishing.
  const editorHandles = useRef<Map<string, TokenTextEditorHandle | null>>(new Map())
  const editorRefCallbacks = useRef<Map<string, (handle: TokenTextEditorHandle | null) => void>>(new Map())
  const activeFieldRef = useRef<string | null>(null)
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
  }
  // While any non-token input is focused, datatree inserts are blocked
  // entirely; blur restores the normal fallback behavior.
  const blockActive = () => {
    activeFieldRef.current = NON_TOKEN_FOCUSED
  }
  const unblockActive = () => {
    if (activeFieldRef.current === NON_TOKEN_FOCUSED) activeFieldRef.current = null
  }
  useEffect(() => {
    activeFieldRef.current = null
  }, [node.id])
  useEffect(() => {
    if (!isWorkspace) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      // Alt+←/→ walks to the neighbouring step. Skipped while a field has focus
      // so Option+Arrow keeps its word-wise cursor movement inside the editors.
      if (!event.altKey || !onNavigate) return
      const el = event.target as HTMLElement | null
      if (el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable)) return
      const target = event.key === 'ArrowLeft' ? navigation?.previous : event.key === 'ArrowRight' ? navigation?.next : undefined
      if (!target) return
      event.preventDefault()
      onNavigate(target.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isWorkspace, onClose, onNavigate, navigation])
  useEffect(() => {
    if (node.type !== 'http') return
    fetch('/api/http-credentials', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (data?.success && Array.isArray(data.credentials)) setHttpCredentials(data.credentials)
      })
      .catch(() => undefined)
  }, [node.type])

  const rawJson = (value: unknown, empty: string) => {
    if (value === undefined || value === null) return empty
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }

  const setLabel = (label: string) => onChange({ ...node, data: { ...node.data, label } } as FlowNode)

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

  return (
    <div
      className={cn(
        'flex h-full w-full flex-col overflow-hidden bg-card',
        isWorkspace ? 'rounded-2xl border border-border shadow-2xl' : 'border-l border-border',
      )}
      data-node-configuration={layout}
    >
      <div className={cn('flex items-center justify-between border-b border-border', isWorkspace ? 'px-6 py-4' : 'px-4 py-3')}>
        <div className="flex min-w-0 items-center gap-3">
          {isWorkspace && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">
              <Settings2 className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0">
            <h2 className={cn('font-semibold', isWorkspace ? 'text-base' : 'text-sm')}>
              {isTrigger ? 'Configure trigger' : ((node.data as { label?: string }).label?.trim() || 'Configure step')}
            </h2>
            {isWorkspace && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isTrigger ? 'Trigger settings' : `${NODE_TYPES.find((entry) => entry.value === node.type)?.label ?? node.type} · Parameters`}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {navigation && onNavigate && navigation.total > 1 && (
            <div className="mr-1 flex items-center gap-0.5 border-r border-border pr-2.5">
              <button
                type="button"
                onClick={() => navigation.previous && onNavigate(navigation.previous.id)}
                disabled={!navigation.previous}
                aria-label="Previous step"
                title={navigation.previous ? `Previous step — ${navigation.previous.label} (⌥←)` : 'This is the first step'}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[3rem] text-center font-mono text-xs tabular-nums text-muted-foreground">
                {navigation.index}/{navigation.total}
              </span>
              <button
                type="button"
                onClick={() => navigation.next && onNavigate(navigation.next.id)}
                disabled={!navigation.next}
                aria-label="Next step"
                title={navigation.next ? `Next step — ${navigation.next.label} (⌥→)` : 'This is the last step'}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
          {isWorkspace && !isTrigger && onExecuteOnly && (
            <Button type="button" size="sm" variant="outline" onClick={onExecuteOnly} title="Runs only this step, using the last run's data for the steps before it">
              <Play className="mr-1.5 h-4 w-4" /> Only this step
            </Button>
          )}
          {isWorkspace && !isTrigger && onExecuteStep && (
            <Button type="button" size="sm" onClick={onExecuteStep}>
              <Play className="mr-1.5 h-4 w-4" /> Execute step
            </Button>
          )}
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground">
            <X className={isWorkspace ? 'h-5 w-5' : 'h-4 w-4'} />
          </button>
        </div>
      </div>

      <div className={cn('min-h-0 flex-1', isWorkspace && 'grid lg:grid-cols-[minmax(250px,0.8fr)_minmax(480px,1.25fr)_minmax(250px,0.8fr)]')}>
        {isWorkspace && (
          <aside className="hidden min-h-0 flex-col border-r border-border bg-slate-50/70 lg:flex">
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-indigo-600" />
                <p className="text-sm font-semibold">Input</p>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">Raw JSON this step received on the selected run — its resolved input, or the upstream data feeding it.</p>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
              <pre className="max-h-[45%] overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-graphite-950 p-3 font-mono text-[11px] leading-5 text-graphite-100">
                {rawJson(rawInput, 'No input data yet.\nExecute the previous nodes to inspect their raw output here.')}
              </pre>
              {!isTrigger && onExecutePrevious && rawInput === undefined && (
                <Button type="button" variant="outline" size="sm" className="w-full" onClick={onExecutePrevious}>
                  <Play className="mr-1.5 h-4 w-4" /> Execute previous nodes
                </Button>
              )}
              <div>
                <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Insert a value</p>
                <DataTree fields={dataFields} onInsert={insertToken} title="Available input data" />
              </div>
            </div>
          </aside>
        )}

        <div className="flex min-h-0 min-w-0 flex-col">
          <div
            className={cn(
              'flex-1 space-y-5 overflow-y-auto',
              isWorkspace
                ? 'mx-auto w-full max-w-4xl p-6 md:p-8 md:[&_[data-flow-data-tree]]:hidden'
                : 'p-4',
            )}
          >
        {issues && issues.length > 0 && (
          <div
            className={cn(
              'rounded-md border p-3 text-sm',
              issues.some((issue) => issue.level === 'error') ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50',
            )}
          >
            <p className="font-semibold text-slate-900">This step needs attention</p>
            <ul className="mt-2 space-y-1.5">
              {[...issues]
                .sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1))
                .map((issue, issueIndex) => (
                  <li key={issueIndex} className="flex items-start gap-2 text-slate-700">
                    <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', issue.level === 'error' ? 'bg-red-500' : 'bg-amber-500')} />
                    <span className="min-w-0">{issue.message}</span>
                  </li>
                ))}
            </ul>
          </div>
        )}
        {isTrigger ? (
          <TriggerEditor
            flowId={flowId}
            trigger={trigger}
            onChange={(nextTrigger) => onChange({ ...node, data: { trigger: nextTrigger } })}
            published={published}
            toolCatalog={toolCatalog}
            onPersisted={onFlowPersisted}
          >
            <InputFieldsEditor
              fields={trigger.inputFields ?? []}
              onChange={(inputFields) => onChange({ ...node, data: { trigger: { ...trigger, inputFields: inputFields.length ? inputFields : undefined } } })}
            />
          </TriggerEditor>
        ) : (
          <>
            {/* Step type selector removed — a node's type is fixed once added. */}
            {/* Label/Notes are hidden for HTTP so its Parameters view stays lean
                like n8n; other node types keep them. */}
            {node.type !== 'http' && (
              <>
                <div>
                  <label className={labelClass}>Label (optional)</label>
                  <input className={fieldClass} value={(node.data as { label?: string }).label ?? ''} placeholder="A short name for this step" onFocus={blockActive} onBlur={unblockActive} onChange={(e) => setLabel(e.target.value)} />
                </div>
                <div>
                  <label className={labelClass}>Notes (optional)</label>
                  <textarea
                    rows={2}
                    className={fieldClass}
                    value={(node.data as { note?: string }).note ?? ''}
                    placeholder="Why this step exists, gotchas, links…"
                    onFocus={blockActive}
                    onBlur={unblockActive}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, note: e.target.value || undefined } } as FlowNode)}
                  />
                </div>
              </>
            )}
            {PER_ITEM_TYPES.has(node.type) && (
              <PerItemSection
                node={node}
                onChange={onChange}
                dataFields={dataFields}
                labelCtx={labelCtx}
                registerEditor={registerEditor}
                focusEditor={focusEditor}
                insertToken={insertToken}
              />
            )}
          </>
        )}

        {node.type === 'agent' && (
          <>
            <div>
              <label className={labelClass}>Agent</label>
              <select className={fieldClass} value={node.data.agentId} onChange={(e) => onChange({ ...node, data: { ...node.data, agentId: e.target.value } })}>
                <option value="">Select an agent…</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.title}
                  </option>
                ))}
              </select>
              {agents.length === 0 && <p className="mt-1.5 text-xs text-amber-600">No agents yet — create one first.</p>}
            </div>
            <div>
              <label className={labelClass}>Message to agent</label>
              <TokenTextEditor
                ref={registerEditor('agent.input')}
                previewCtx={previewCtx}
                multiline
                rows={6}
                value={node.data.input ?? ''}
                labelCtx={labelCtx}
                placeholder="Tell the agent what to do. Add flow data from the picker below when needed."
                onFocus={focusEditor('agent.input')}
                onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
                ariaLabel="Message to agent"
              />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <div>
              <label className={labelClass}>Data from earlier steps</label>
              <select
                className={fieldClass}
                value={node.data.includeUpstreamContext === true ? 'on' : 'off'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, includeUpstreamContext: e.target.value === 'on' } })}
              >
                <option value="on">Include every earlier step&apos;s data (recommended)</option>
                <option value="off">Only what the message references</option>
              </select>
              <p className="mt-1.5 text-xs text-muted-foreground">
                When on, the data captured by the API and other steps before this one is added to the
                agent&apos;s context automatically — so it has everything it needs without wiring each token.
              </p>
            </div>
            <AdvancedParamsSection node={node} onChange={onChange} defaultOpen />
            <div>
              <label className={labelClass}>Human assistance</label>
              <select
                className={fieldClass}
                value={node.data.humanAssistance === false ? 'off' : 'on'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, humanAssistance: e.target.value === 'off' ? false : undefined } })}
              >
                <option value="on">Pause and ask when unsure</option>
                <option value="off">Never ask — fail instead</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Agent response</label>
              <select
                className={fieldClass}
                value={node.data.responseFormat ?? 'text'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, responseFormat: e.target.value === 'structured' ? 'structured' : undefined } })}
              >
                <option value="text">Text only</option>
                <option value="structured">Structured (JSON matching output fields)</option>
              </select>
              {node.data.responseFormat === 'structured' && !(node.data.outputFields ?? []).some((f) => f.name.trim()) && (
                <p className="mt-1.5 text-xs text-amber-600">Add at least one output field below to define the JSON shape.</p>
              )}
            </div>
            <OutputFieldsEditor
              fields={node.data.outputFields ?? []}
              onChange={(outputFields) => onChange({ ...node, data: { ...node.data, outputFields: outputFields.length ? outputFields : undefined } })}
              blockActive={blockActive}
              unblockActive={unblockActive}
            />
          </>
        )}

        {node.type === 'ai' && (
          <>
            <div>
              <label className={labelClass}>Operation</label>
              <select className={fieldClass} value={node.data.aiOp} onChange={(e) => onChange({ ...node, data: { ...node.data, aiOp: e.target.value as AiOp } })}>
                {AI_OPS.map((op) => (
                  <option key={op} value={op}>
                    {AI_OP_LABELS[op]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>{node.data.aiOp === 'ask' ? 'Prompt' : 'Guidance (optional)'}</label>
              <TokenTextEditor
                ref={registerEditor('ai.instructions')}
                multiline
                rows={4}
                value={node.data.instructions ?? ''}
                labelCtx={labelCtx}
                placeholder={node.data.aiOp === 'ask' ? 'Tell AI what to do with the input.' : 'Optional extra direction for this operation.'}
                onFocus={focusEditor('ai.instructions')}
                onChange={(instructions) => onChange({ ...node, data: { ...node.data, instructions } })}
                ariaLabel="AI instructions"
              />
            </div>
            <div>
              <label className={labelClass}>Input</label>
              <TokenTextEditor
                ref={registerEditor('ai.input')}
                previewCtx={previewCtx}
                multiline
                rows={3}
                value={node.data.input ?? ''}
                labelCtx={labelCtx}
                placeholder="The content to work on — pick flow data from below."
                onFocus={focusEditor('ai.input')}
                onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
                ariaLabel="AI input"
              />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <div>
              <label className={labelClass}>Model</label>
              <select
                className={fieldClass}
                value={node.data.model ?? 'fast'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, model: e.target.value === 'smart' ? 'smart' : undefined } })}
              >
                <option value="fast">Fast (default)</option>
                <option value="smart">Smart (higher quality, slower)</option>
              </select>
            </div>
            {node.data.aiOp === 'extract' && (
              <OutputFieldsEditor
                fields={node.data.outputFields ?? []}
                onChange={(outputFields) => onChange({ ...node, data: { ...node.data, outputFields: outputFields.length ? outputFields : undefined } })}
                blockActive={blockActive}
                unblockActive={unblockActive}
              />
            )}
            {node.data.aiOp === 'categorize' && (
              <div>
                <label className={labelClass}>Categories</label>
                <div className="space-y-1.5">
                  {(node.data.categories ?? []).map((category, i) => (
                    <div key={i} className="flex gap-1.5">
                      <input
                        className={`${smallField} min-w-0 flex-1`}
                        value={category}
                        placeholder="e.g. Urgent"
                        onChange={(e) => onChange({ ...node, data: { ...node.data, categories: (node.data.categories ?? []).map((c, j) => (j === i ? e.target.value : c)) } })}
                        aria-label={`Category ${i + 1}`}
                      />
                      <button
                        type="button"
                        onClick={() => onChange({ ...node, data: { ...node.data, categories: (node.data.categories ?? []).filter((_, j) => j !== i) } })}
                        className="px-1 text-red-500 hover:text-red-700"
                        aria-label="Remove category"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => onChange({ ...node, data: { ...node.data, categories: [...(node.data.categories ?? []), ''] } })}
                  className="mt-1.5 flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
                >
                  <Plus className="h-3.5 w-3.5" /> Add category
                </button>
              </div>
            )}
            {node.data.aiOp === 'score' && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Lowest score</label>
                  <input
                    type="number"
                    className={fieldClass}
                    value={node.data.scoreMin ?? 1}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, scoreMin: Number(e.target.value) } })}
                    aria-label="Lowest score"
                  />
                </div>
                <div>
                  <label className={labelClass}>Highest score</label>
                  <input
                    type="number"
                    className={fieldClass}
                    value={node.data.scoreMax ?? 10}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, scoreMax: Number(e.target.value) } })}
                    aria-label="Highest score"
                  />
                </div>
              </div>
            )}
            <AdvancedParamsSection node={node} onChange={onChange} />
          </>
        )}

        {node.type === 'knowledge' && (
          <>
            <div>
              <label className={labelClass}>What to look for</label>
              <TokenTextEditor
                ref={registerEditor('knowledge.query')}
                multiline
                rows={3}
                value={node.data.query ?? ''}
                labelCtx={labelCtx}
                placeholder="Describe what you need — add flow data from below."
                onFocus={focusEditor('knowledge.query')}
                onChange={(query) => onChange({ ...node, data: { ...node.data, query } })}
                ariaLabel="Knowledge search query"
              />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <div>
              <label className={labelClass}>How many passages</label>
              <input
                type="number"
                min={1}
                max={20}
                className={fieldClass}
                value={node.data.topK ?? 5}
                onChange={(e) => onChange({ ...node, data: { ...node.data, topK: Number(e.target.value) || undefined } })}
                aria-label="How many passages"
              />
            </div>
            <p className="text-xs text-muted-foreground">Searches the documents uploaded to your workspace and outputs the best-matching passages as a list.</p>
          </>
        )}

        {node.type === 'subflow' && (
          <SubflowDrawerSection node={node} onChange={onChange} flowId={flowId} labelCtx={labelCtx} registerEditor={registerEditor} focusEditor={focusEditor} dataFields={dataFields} insertToken={insertToken} />
        )}

        {node.type === 'condition' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Match</label>
              <select
                className={fieldClass}
                value={node.data.match ?? 'all'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, match: e.target.value as 'all' | 'any', clauses: clausesOf(node.data), left: undefined, op: undefined, right: undefined } })}
              >
                <option value="all">All conditions (AND)</option>
                <option value="any">Any condition (OR)</option>
              </select>
            </div>
            {clausesOf(node.data).map((clause, i) => {
              const clauses = clausesOf(node.data)
              const update = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next, left: undefined, op: undefined, right: undefined } })
              return (
                <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
                  <TokenTextEditor
                    ref={registerEditor(`cond.${i}.left`)}
                    className="px-2 py-1.5"
                    value={clause.left}
                    labelCtx={labelCtx}
                    placeholder="Choose data from below"
                    onFocus={focusEditor(`cond.${i}.left`)}
                    onChange={(left) => update(clauses.map((c, j) => (j === i ? { ...c, left } : c)))}
                    ariaLabel={`Condition ${i + 1} value`}
                  />
                  <div className="flex gap-1.5">
                    <select className={smallField} value={clause.op} onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}>
                      {CONDITION_OPS.map((op) => (
                        <option key={op} value={op}>
                          {CONDITION_OP_LABELS[op]}
                        </option>
                      ))}
                    </select>
                    <TokenTextEditor
                      ref={registerEditor(`cond.${i}.right`)}
                      className="min-w-0 flex-1 px-2 py-1.5"
                      value={clause.right}
                      labelCtx={labelCtx}
                      placeholder="80"
                      onFocus={focusEditor(`cond.${i}.right`)}
                      onChange={(right) => update(clauses.map((c, j) => (j === i ? { ...c, right } : c)))}
                      ariaLabel={`Condition ${i + 1} comparison value`}
                    />
                    {clauses.length > 1 && (
                      <button type="button" onClick={() => update(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove condition">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
            <button
              type="button"
              onClick={() => onChange({ ...node, data: { ...node.data, clauses: [...clausesOf(node.data), { left: '', op: 'contains', right: '' }], left: undefined, op: undefined, right: undefined } })}
              className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              <Plus className="h-3.5 w-3.5" /> Add condition
            </button>
            <div>
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
          </div>
        )}

        {node.type === 'loop' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Items to process</label>
              <TokenTextEditor
                ref={registerEditor('loop.over')}
                value={node.data.over}
                labelCtx={labelCtx}
                placeholder="Choose a list from the available data below"
                onFocus={focusEditor('loop.over')}
                onChange={(over) => onChange({ ...node, data: { ...node.data, over } })}
                ariaLabel="Items to process"
              />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">Accepts a JSON list, a newline list, or a comma-separated list. Nested steps run once for each item.</p>
            </div>
            <div>
              <label className={labelClass}>At a time</label>
              <input
                type="number"
                min={1}
                max={20}
                className={fieldClass}
                value={node.data.concurrency ?? 3}
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => onChange({ ...node, data: { ...node.data, concurrency: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } })}
              />
            </div>
            <div>
              <label className={labelClass}>If an item fails</label>
              <select
                className={fieldClass}
                value={node.data.itemError ?? 'fail'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, itemError: e.target.value === 'fail' ? undefined : (e.target.value as 'skip' | 'collect') } })}
              >
                <option value="fail">Stop the whole loop</option>
                <option value="skip">Skip that item, keep the rest</option>
                <option value="collect">Keep going, record the error in its place</option>
              </select>
            </div>
            {onAddStep && (
              <AddNestedStepMenu label="Add step to loop" onPick={onAddStep} />
            )}
          </div>
        )}

        {node.type === 'parallel' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Runs {node.data.branches.length} branch{node.data.branches.length === 1 ? '' : 'es'} at once and merges their outputs. Click an indented card to edit a branch step.
            </p>
            {onAddStep && (
              <AddNestedStepMenu label="Add parallel branch" onPick={onAddStep} />
            )}
          </div>
        )}

        {node.type === 'tool' && (
          <ToolConfigurationSection
            node={node}
            toolCatalog={toolCatalog}
            dataFields={dataFields}
            labelCtx={labelCtx}
            onChange={onChange}
          />
        )}

        {node.type === 'http' && (
          <div className="space-y-5">
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => setCurlDialogOpen(true)}>
                <TerminalSquare className="mr-1.5 h-4 w-4" /> Import cURL
              </Button>
            </div>
            <div>
              <label className={labelClass}>Method</label>
              <select
                className={fieldClass}
                value={node.data.method}
                onChange={(e) => onChange({ ...node, data: { ...node.data, method: e.target.value as typeof node.data.method } })}
              >
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>URL</label>
              <input
                type="url"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={fieldClass}
                value={node.data.url}
                placeholder="https://api.example.com/v1/resource"
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(event) => onChange({ ...node, data: { ...node.data, url: event.target.value } })}
                aria-label="Request URL"
              />
            </div>

            <div>
              <label className={labelClass}>Authentication</label>
              <select
                className={fieldClass}
                value={httpAuthMode}
                onChange={(event) => {
                  const mode = event.target.value as 'none' | 'predefined' | 'generic'
                  setHttpAuthMode(mode)
                  if (mode !== 'predefined' && node.data.connectionId) onChange({ ...node, data: { ...node.data, connectionId: undefined } })
                  if (mode !== 'generic' && node.data.credentialId) onChange({ ...node, data: { ...node.data, credentialId: undefined } })
                }}
              >
                <option value="none">None</option>
                <option value="predefined">Predefined Credential Type</option>
                <option value="generic">Generic Credential Type</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {httpAuthMode === 'predefined'
                  ? 'Reuse a connected integration for authentication.'
                  : httpAuthMode === 'generic'
                    ? 'Choose an auth method, then set up a reusable credential for this host.'
                    : 'No authentication is sent with the request.'}
              </p>
            </div>

            {httpAuthMode === 'predefined' && (
              <div>
                <label className={labelClass}>Predefined credential</label>
                {predefinedConnections.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    No connected integrations yet. Connect one under Integrations, then it appears here.
                  </p>
                ) : (
                  <select
                    className={fieldClass}
                    value={node.data.connectionId ?? ''}
                    onChange={(event) => onChange({ ...node, data: { ...node.data, connectionId: event.target.value || undefined, credentialId: undefined } })}
                  >
                    <option value="">Choose a connection…</option>
                    {predefinedConnections.map((connection) => (
                      <option key={connection.id} value={connection.id}>{connection.name}</option>
                    ))}
                  </select>
                )}
              </div>
            )}

            {httpAuthMode === 'generic' && (
              <div>
                <label className={labelClass}>Generic Auth Type</label>
                <select
                  className={fieldClass}
                  value={httpCredentials.find((credential) => credential.id === node.data.credentialId)?.authType ?? ''}
                  onChange={(event) => {
                    if (!event.target.value) return
                    setNewCredentialType(event.target.value as HttpAuthOption)
                    setCredentialDialogOpen(true)
                  }}
                >
                  <option value="">Select…</option>
                  {HTTP_AUTH_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            )}

            {httpAuthMode === 'generic' && (node.data.credentialId || httpCredentials.length > 0) && (
              <div>
                <label className={labelClass}>Credential</label>
                <div className="flex gap-2">
                  <select
                    className={`${fieldClass} min-w-0 flex-1`}
                    value={node.data.credentialId ?? ''}
                    onChange={(event) => onChange({
                      ...node,
                      data: { ...node.data, credentialId: event.target.value || undefined, connectionId: undefined },
                    })}
                  >
                    <option value="">Choose a verified credential…</option>
                    {httpCredentials.map((credential) => (
                      <option key={credential.id} value={credential.id}>
                        {credential.name} · {credential.allowedHost}
                      </option>
                    ))}
                  </select>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setNewCredentialType(
                        (httpCredentials.find((credential) => credential.id === node.data.credentialId)?.authType || 'basic') as HttpAuthOption,
                      )
                      setCredentialDialogOpen(true)
                    }}
                  >
                    <KeyRound className="mr-1.5 h-4 w-4" /> Set up new
                  </Button>
                </div>
                {node.data.credentialId && (() => {
                  const selected = httpCredentials.find((entry) => entry.id === node.data.credentialId)
                  const flagged = selected?.status === 'error'
                  return (
                    <div className="mt-1.5 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className={cn('flex items-center gap-1.5 text-xs', flagged ? 'text-amber-700' : 'text-emerald-700')}>
                          <span className={cn('h-1.5 w-1.5 rounded-full', flagged ? 'bg-amber-500' : 'bg-emerald-500')} />
                          {flagged
                            ? 'This credential was rejected on a recent run.'
                            : 'Verified credential — secrets are encrypted and excluded from the flow.'}
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-xs"
                          disabled={reverifyingCredential}
                          onClick={async () => {
                            if (!node.data.credentialId) return
                            setReverifyingCredential(true)
                            try {
                              const response = await fetch('/api/http-credentials', {
                                method: 'PATCH',
                                headers: { 'content-type': 'application/json' },
                                body: JSON.stringify({ id: node.data.credentialId, url: node.data.url, method: node.data.method }),
                              })
                              const data = await response.json().catch(() => ({}))
                              if (!response.ok) {
                                toast.error(data.error || 'The credential could not be verified.')
                                if (data.credential) setHttpCredentials((current) => current.map((entry) => entry.id === data.credential.id ? data.credential : entry))
                                return
                              }
                              toast.success('Credential re-verified.')
                              setHttpCredentials((current) => current.map((entry) => entry.id === data.credential.id ? data.credential : entry))
                            } catch {
                              toast.error('The credential could not be verified.')
                            } finally {
                              setReverifyingCredential(false)
                            }
                          }}
                        >
                          {reverifyingCredential ? 'Verifying…' : 'Re-verify'}
                        </Button>
                      </div>
                      {flagged && selected?.lastError && (
                        <p className="text-xs text-amber-700/80">{selected.lastError}</p>
                      )}
                    </div>
                  )
                })()}
              </div>
            )}

            <div className="space-y-3 border-t pt-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Send query parameters</p>
                  <p className="text-xs text-muted-foreground">Add JSON key/value parameters to the URL.</p>
                </div>
                <Switch
                  checked={node.data.sendQuery ?? Boolean(node.data.query?.trim())}
                  onCheckedChange={(sendQuery) => onChange({ ...node, data: { ...node.data, sendQuery } })}
                  aria-label="Send query parameters"
                />
              </div>
              {(node.data.sendQuery ?? Boolean(node.data.query?.trim())) && (
                <KeyValueJsonEditor
                  label="Query parameters"
                  value={node.data.query}
                  keyPlaceholder="account_id"
                  valuePlaceholder="Value or input data"
                  helper="Stored as a JSON object. Arrays become repeated query parameters."
                  onChange={(query) => onChange({ ...node, data: { ...node.data, query } })}
                  labelCtx={labelCtx}
                  editorKey="http.query"
                  registerEditor={registerEditor}
                  focusEditor={focusEditor}
                  blockActive={blockActive}
                  unblockActive={unblockActive}
                />
              )}
            </div>

            <div className="space-y-3 border-t pt-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Send headers</p>
                  <p className="text-xs text-muted-foreground">Add non-secret request headers as JSON.</p>
                </div>
                <Switch
                  checked={node.data.sendHeaders ?? Boolean(node.data.headers?.trim())}
                  onCheckedChange={(sendHeaders) => onChange({ ...node, data: { ...node.data, sendHeaders } })}
                  aria-label="Send headers"
                />
              </div>
              {(node.data.sendHeaders ?? Boolean(node.data.headers?.trim())) && (
                <KeyValueJsonEditor
                  label="Headers"
                  value={node.data.headers}
                  keyPlaceholder="Content-Language"
                  valuePlaceholder="en-US"
                  helper="Stored as a JSON object. Put reusable secrets in Authentication, not here."
                  onChange={(headers) => onChange({ ...node, data: { ...node.data, headers } })}
                  labelCtx={labelCtx}
                  editorKey="http.headers"
                  registerEditor={registerEditor}
                  focusEditor={focusEditor}
                  blockActive={blockActive}
                  unblockActive={unblockActive}
                />
              )}
            </div>

            <div className="space-y-3 border-t pt-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Send body</p>
                  <p className="text-xs text-muted-foreground">Configure the request payload.</p>
                </div>
                <Switch
                  checked={node.data.sendBody ?? Boolean(node.data.body?.trim())}
                  disabled={node.data.method === 'GET' || node.data.method === 'HEAD'}
                  onCheckedChange={(sendBody) => onChange({ ...node, data: { ...node.data, sendBody } })}
                  aria-label="Send body"
                />
              </div>
              {(node.data.method === 'GET' || node.data.method === 'HEAD') && (
                <p className="text-xs text-amber-700">HTTP {node.data.method} requests do not send a body.</p>
              )}
              {(node.data.sendBody ?? Boolean(node.data.body?.trim())) && node.data.method !== 'GET' && node.data.method !== 'HEAD' && (
                <>
                  <div>
                    <label className={labelClass}>Body content type</label>
                    <select
                      className={fieldClass}
                      value={node.data.bodyMode === 'text' ? 'raw' : (node.data.bodyMode ?? 'json')}
                      onChange={(event) => onChange({
                        ...node,
                        data: { ...node.data, bodyMode: event.target.value as Exclude<typeof node.data.bodyMode, 'text' | undefined> },
                      })}
                    >
                      <option value="json">JSON</option>
                      <option value="raw">Raw</option>
                      <option value="graphql">GraphQL</option>
                      <option value="form-urlencoded">Form URL Encoded</option>
                      <option value="form-data">Form-Data (Multipart)</option>
                    </select>
                  </div>
                  {node.data.bodyMode === 'form-urlencoded' || node.data.bodyMode === 'form-data' ? (
                    <KeyValueJsonEditor
                      label="Body fields"
                      value={node.data.body}
                      keyPlaceholder="field"
                      valuePlaceholder="Value or input data"
                      helper={node.data.bodyMode === 'form-data'
                        ? 'These JSON fields are sent as multipart/form-data. File uploads are not yet supported.'
                        : 'These JSON fields are encoded as application/x-www-form-urlencoded.'}
                      onChange={(body) => onChange({ ...node, data: { ...node.data, body } })}
                      labelCtx={labelCtx}
                      editorKey="http.body"
                      registerEditor={registerEditor}
                      focusEditor={focusEditor}
                      blockActive={blockActive}
                      unblockActive={unblockActive}
                    />
                  ) : (
                    <div>
                      {(node.data.bodyMode === 'raw' || node.data.bodyMode === 'text') && (
                        <div className="mb-3">
                          <label className={labelClass}>Content type</label>
                          <input
                            className={fieldClass}
                            value={node.data.contentType ?? ''}
                            placeholder="text/plain"
                            onChange={(event) => onChange({ ...node, data: { ...node.data, contentType: event.target.value || undefined } })}
                          />
                        </div>
                      )}
                      <label className={labelClass}>
                        {node.data.bodyMode === 'graphql' ? 'GraphQL query or JSON request' : node.data.bodyMode === 'raw' || node.data.bodyMode === 'text' ? 'Raw body' : 'JSON body'}
                      </label>
                      <TokenTextEditor
                        ref={registerEditor('http.body')}
                previewCtx={previewCtx}
                        multiline
                        rows={8}
                        className="font-mono text-xs"
                        value={node.data.body ?? ''}
                        labelCtx={labelCtx}
                        placeholder={
                          node.data.bodyMode === 'graphql'
                            ? 'query GetAccount { account { id name } }'
                            : node.data.bodyMode === 'raw' || node.data.bodyMode === 'text'
                              ? 'Raw request content'
                              : '{\n  "name": "Use a value from Input"\n}'
                        }
                        onFocus={focusEditor('http.body')}
                        onChange={(body) => onChange({ ...node, data: { ...node.data, body: body || undefined } })}
                        ariaLabel="Request body"
                      />
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="space-y-3 border-t pt-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Follow redirects</p>
                  <p className="text-xs text-muted-foreground">Each hop is re-checked against the SSRF guard; credentials are dropped on cross-origin hops.</p>
                </div>
                <Switch
                  checked={node.data.followRedirects ?? false}
                  onCheckedChange={(followRedirects) => onChange({ ...node, data: { ...node.data, followRedirects } })}
                  aria-label="Follow redirects"
                />
              </div>
            </div>

            <details className="rounded-lg border border-border/70 p-2">
              <summary className="cursor-pointer text-sm font-medium">Pagination — fetch every page</summary>
              <div className="mt-3 space-y-3">
                <select
                  className={fieldClass}
                  value={node.data.pagination?.mode ?? 'off'}
                  onChange={(e) => {
                    const mode = e.target.value
                    onChange({ ...node, data: { ...node.data, pagination: mode === 'off' ? undefined : { ...(node.data.pagination ?? {}), mode: mode as 'updateParam' | 'nextUrl' } } })
                  }}
                >
                  <option value="off">Off — one request</option>
                  <option value="updateParam">Increment a page/offset parameter</option>
                  <option value="nextUrl">Follow a next-page URL in the response</option>
                </select>
                {node.data.pagination && (
                  <div className="grid grid-cols-2 gap-2">
                    {node.data.pagination.mode === 'updateParam' && (
                      <>
                        <label className="text-xs">Parameter<input className={fieldClass} placeholder="page" value={node.data.pagination.param ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, param: e.target.value || undefined } } })} /></label>
                        <label className="text-xs">Start at<input type="number" className={fieldClass} placeholder="1" value={node.data.pagination.start ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, start: e.target.value === '' ? undefined : Number(e.target.value) } } })} /></label>
                      </>
                    )}
                    {node.data.pagination.mode === 'nextUrl' && (
                      <label className="col-span-2 text-xs">Next-URL field (path in response)<input className={fieldClass} placeholder="links.next" value={node.data.pagination.nextUrlPath ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, nextUrlPath: e.target.value || undefined } } })} /></label>
                    )}
                    <label className="text-xs">List field (path)<input className={fieldClass} placeholder="data" value={node.data.pagination.itemsPath ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, itemsPath: e.target.value || undefined } } })} /></label>
                    <label className="text-xs">Max pages<input type="number" min={1} max={50} className={fieldClass} placeholder="5" value={node.data.pagination.maxPages ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, maxPages: e.target.value === '' ? undefined : Math.max(1, Math.min(50, Number(e.target.value))) } } })} /></label>
                    <label className="text-xs">Stop when<select className={fieldClass} value={node.data.pagination.completeWhen ?? 'emptyPage'} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, completeWhen: e.target.value as 'emptyPage' | 'statusCode' | 'pathMissing' } } })}>
                      <option value="emptyPage">A page comes back empty</option>
                      <option value="statusCode">The response has a certain status</option>
                      <option value="pathMissing">A field in the response says there is no more</option>
                    </select></label>
                    {node.data.pagination.completeWhen === 'statusCode' && (
                      <label className="text-xs">Stop on these statuses<input className={fieldClass} placeholder="404, 204" value={node.data.pagination.completeStatusCodes ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, completeStatusCodes: e.target.value || undefined } } })} /></label>
                    )}
                    {node.data.pagination.completeWhen === 'pathMissing' && (
                      <label className="text-xs">Field that says &ldquo;more pages&rdquo;<input className={fieldClass} placeholder="has_more" value={node.data.pagination.completePath ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, completePath: e.target.value || undefined } } })} /></label>
                    )}
                    <label className="text-xs">Pause between pages (ms)<input type="number" min={0} max={10000} className={fieldClass} placeholder="0" value={node.data.pagination.intervalMs ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, pagination: { ...node.data.pagination!, intervalMs: e.target.value === '' ? undefined : Math.max(0, Math.min(10000, Number(e.target.value))) } } })} /></label>
                  </div>
                )}
                {node.data.pagination && <p className="text-xs text-muted-foreground">Items from every page are combined into one list in the output.</p>}
              </div>
            </details>

            <details className="rounded-lg border border-border/70 p-2">
              <summary className="cursor-pointer text-sm font-medium">Optimize response for AI</summary>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="col-span-2 text-xs">Keep only this part (path)<input className={fieldClass} placeholder="data" value={node.data.optimizeForAi?.dataPath ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, optimizeForAi: cleanOptimize({ ...node.data.optimizeForAi, dataPath: e.target.value || undefined }) } })} /></label>
                <label className="col-span-2 text-xs">Keep only these fields (comma-separated)<input className={fieldClass} placeholder="id, name, email" value={(node.data.optimizeForAi?.fields ?? []).join(', ')} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, optimizeForAi: cleanOptimize({ ...node.data.optimizeForAi, fields: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }) } })} /></label>
                <label className="text-xs">Max items<input type="number" min={1} className={fieldClass} placeholder="No limit" value={node.data.optimizeForAi?.maxItems ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, optimizeForAi: cleanOptimize({ ...node.data.optimizeForAi, maxItems: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) }) } })} /></label>
              </div>
            </details>

            <p className="text-xs text-muted-foreground">Calls a public HTTPS endpoint. The raw status, response headers, parsed body, and response text appear in Output.</p>
          </div>
        )}

        {node.type === 'transform' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Create named fields for later steps to use.</p>
            {node.data.fields.map((field, i) => (
              <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
                <div className="flex gap-1.5">
                  <input
                    className={`${smallField} flex-1`}
                    value={field.name}
                    placeholder="fieldName"
                    onFocus={blockActive}
                    onBlur={unblockActive}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, fields: node.data.fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)) } })}
                  />
                  <select
                    className={`${smallField} w-24`}
                    value={field.type ?? 'any'}
                    aria-label={`Type for field ${field.name || i + 1}`}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, fields: node.data.fields.map((f, j) => (j === i ? { ...f, type: e.target.value === 'any' ? undefined : (e.target.value as FieldType) } : f)) } })}
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>{t === 'any' ? 'As-is' : t}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, fields: node.data.fields.filter((_, j) => j !== i) } })} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove field">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <TokenTextEditor
                  ref={registerEditor(`xf.${i}`)}
                  className="px-2 py-1.5"
                  value={field.value}
                  labelCtx={labelCtx}
                  placeholder="Value for this field"
                  onFocus={focusEditor(`xf.${i}`)}
                  onChange={(value) => onChange({ ...node, data: { ...node.data, fields: node.data.fields.map((f, j) => (j === i ? { ...f, value } : f)) } })}
                  ariaLabel={`Value for field ${field.name || i + 1}`}
                />
              </div>
            ))}
            <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, fields: [...node.data.fields, { name: '', value: '' }] } })} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
              <Plus className="h-3.5 w-3.5" /> Add field
            </button>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={node.data.includeOtherFields === true}
                onChange={(e) => onChange({ ...node, data: { ...node.data, includeOtherFields: e.target.checked || undefined } })}
              />
              Also keep the fields that came in
            </label>
            <div>
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
          </div>
        )}

        {node.type === 'filter' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Continue only when this passes. Inside a For-each, a failing item is dropped from the results.</p>
            <select className={fieldClass} value={node.data.match ?? 'all'} onChange={(e) => onChange({ ...node, data: { ...node.data, match: e.target.value as 'all' | 'any', clauses: clausesOf(node.data) } })}>
              <option value="all">Match all (AND)</option>
              <option value="any">Match any (OR)</option>
            </select>
            {clausesOf(node.data).map((clause, i) => {
              const clauses = clausesOf(node.data)
              const update = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next } })
              return (
                <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
                  <TokenTextEditor ref={registerEditor(`filt.${i}.left`)} className="px-2 py-1.5" value={clause.left} labelCtx={labelCtx} placeholder="Choose data from below" onFocus={focusEditor(`filt.${i}.left`)} onChange={(left) => update(clauses.map((c, j) => (j === i ? { ...c, left } : c)))} ariaLabel={`Filter ${i + 1} value`} />
                  <div className="flex gap-1.5">
                    <select className={smallField} value={clause.op} onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}>
                      {CONDITION_OPS.map((op) => <option key={op} value={op}>{CONDITION_OP_LABELS[op]}</option>)}
                    </select>
                    {!UNARY_CONDITION_OPS.has(clause.op) && (
                      <TokenTextEditor ref={registerEditor(`filt.${i}.right`)} className="min-w-0 flex-1 px-2 py-1.5" value={clause.right} labelCtx={labelCtx} placeholder="80" onFocus={focusEditor(`filt.${i}.right`)} onChange={(right) => update(clauses.map((c, j) => (j === i ? { ...c, right } : c)))} ariaLabel={`Filter ${i + 1} comparison value`} />
                    )}
                    {clauses.length > 1 && (
                      <button type="button" onClick={() => update(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove condition"><Trash2 className="h-4 w-4" /></button>
                    )}
                  </div>
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <input type="checkbox" checked={clause.ignoreCase === true} onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, ignoreCase: e.target.checked || undefined } : c)))} />
                    Ignore upper/lower case
                  </label>
                </div>
              )
            })}
            <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, clauses: [...clausesOf(node.data), { left: '', op: 'contains', right: '' }] } })} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
              <Plus className="h-3.5 w-3.5" /> Add condition
            </button>
            <div><DataTree fields={dataFields} onInsert={insertToken} /></div>
          </div>
        )}

        {node.type === 'switch' && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">The first matching case routes the flow; anything unmatched follows the <strong>default</strong> branch on the canvas.</p>
            {node.data.cases.map((c, i) => (
              <div key={c.id} className="space-y-1.5 rounded-lg border border-border/70 p-2">
                <div className="flex gap-1.5">
                  <input className={`${smallField} flex-1`} value={c.label ?? ''} placeholder={`Case ${i + 1} label`} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) } })} />
                  {node.data.cases.length > 1 && (
                    <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, cases: node.data.cases.filter((_, j) => j !== i) } })} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove case"><Trash2 className="h-4 w-4" /></button>
                  )}
                </div>
                <TokenTextEditor ref={registerEditor(`sw.${i}.left`)} className="px-2 py-1.5" value={c.left} labelCtx={labelCtx} placeholder="Choose data from below" onFocus={focusEditor(`sw.${i}.left`)} onChange={(left) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, left } : x)) } })} ariaLabel={`Case ${i + 1} value`} />
                <div className="flex gap-1.5">
                  <select className={smallField} value={c.op} onChange={(e) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, op: e.target.value as ConditionOp } : x)) } })}>
                    {CONDITION_OPS.map((op) => <option key={op} value={op}>{CONDITION_OP_LABELS[op]}</option>)}
                  </select>
                  <TokenTextEditor ref={registerEditor(`sw.${i}.right`)} className="min-w-0 flex-1 px-2 py-1.5" value={c.right} labelCtx={labelCtx} placeholder="enterprise" onFocus={focusEditor(`sw.${i}.right`)} onChange={(right) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, right } : x)) } })} ariaLabel={`Case ${i + 1} comparison value`} />
                </div>
              </div>
            ))}
            <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, cases: [...node.data.cases, { id: `case${node.data.cases.length + 1}-${Math.random().toString(36).slice(2, 6)}`, left: '', op: 'contains', right: '' }] } })} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
              <Plus className="h-3.5 w-3.5" /> Add case
            </button>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={node.data.allMatches === true}
                onChange={(e) => onChange({ ...node, data: { ...node.data, allMatches: e.target.checked || undefined } })}
              />
              Follow every case that matches, not just the first
            </label>
            <div><DataTree fields={dataFields} onInsert={insertToken} /></div>
          </div>
        )}

        {node.type === 'stop' && (
          <div>
            <label className={labelClass}>Reason (optional)</label>
            <input className={fieldClass} value={node.data.reason ?? ''} placeholder="Why the flow stops here" onChange={(e) => onChange({ ...node, data: { ...node.data, reason: e.target.value } })} />
            <p className="mt-1.5 text-xs text-muted-foreground">Ends the flow early; later steps are skipped.</p>
          </div>
        )}

        {node.type === 'variable' && (
          <VariableEditor
            node={node}
            variableNames={variableNames ?? []}
            onChange={onChange}
            dataFields={dataFields}
            labelCtx={labelCtx}
            registerEditor={registerEditor}
            focusEditor={focusEditor}
            insertToken={insertToken}
            blockActive={blockActive}
            unblockActive={unblockActive}
          />
        )}

        {node.type === 'data' && (
          <DataEditor
            node={node}
            onChange={onChange}
            dataFields={dataFields}
            labelCtx={labelCtx}
            registerEditor={registerEditor}
            focusEditor={focusEditor}
            insertToken={insertToken}
            blockActive={blockActive}
            unblockActive={unblockActive}
          />
        )}

        {node.type === 'humanReview' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Message</label>
              <TokenTextEditor
                ref={registerEditor('hr.message')}
                multiline
                rows={5}
                value={node.data.message}
                labelCtx={labelCtx}
                placeholder="What should the person be asked? Their reply becomes this step's output."
                onFocus={focusEditor('hr.message')}
                onChange={(message) => onChange({ ...node, data: { ...node.data, message } })}
                ariaLabel="Message"
              />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <div>
              <label className={labelClass}>Assign to (optional)</label>
              {/* Empty value = engine default (the run owner is asked). A stored
                  assignee missing from the roster (departed member) stays selected
                  as "Former member" so opening the editor never rewrites data. */}
              <select
                className={fieldClass}
                value={node.data.assigneeUserId ?? ''}
                onChange={(e) => onChange({ ...node, data: { ...node.data, assigneeUserId: e.target.value || undefined } })}
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
              <p className="mt-1.5 text-xs text-muted-foreground">They&apos;ll be notified when the flow pauses here.</p>
            </div>
          </div>
        )}

        {node.type === 'output' && (
          <OutputEditor
            node={node}
            onChange={onChange}
            dataFields={dataFields}
            labelCtx={labelCtx}
            registerEditor={registerEditor}
            focusEditor={focusEditor}
            insertToken={insertToken}
            blockActive={blockActive}
            unblockActive={unblockActive}
          />
        )}

        {node.type === 'code' && (
          <>
            <div>
              <label className={labelClass}>Mode</label>
              <select className={fieldClass} value={node.data.mode} onChange={(e) => onChange({ ...node, data: { ...node.data, mode: e.target.value === 'each' ? 'each' : 'all' } })}>
                <option value="all">Run once for all input</option>
                <option value="each">Run once for each item</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Language</label>
              <select
                className={fieldClass}
                value={node.data.language}
                onChange={(e) => {
                  const language = e.target.value === 'python' ? 'python' : 'javascript'
                  const wasDefault = node.data.code.trim() === 'return input;' || node.data.code.trim() === 'return input'
                  onChange({ ...node, data: { ...node.data, language, code: wasDefault ? (language === 'python' ? 'return input' : 'return input;') : node.data.code } })
                }}
              >
                <option value="javascript">JavaScript</option>
                <option value="python">Python</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Input</label>
              <TokenTextEditor
                ref={registerEditor('code.input')}
                multiline
                rows={3}
                value={node.data.input ?? ''}
                labelCtx={labelCtx}
                placeholder="Choose the data made available as input."
                onFocus={focusEditor('code.input')}
                onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
                ariaLabel="Code input"
              />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <CodeAssist
              language={node.data.language === 'python' ? 'python' : 'javascript'}
              mode={node.data.mode === 'each' ? 'each' : 'all'}
              inputSample={rawInput !== undefined ? JSON.stringify(rawInput, null, 2).slice(0, 4000) : undefined}
              onGenerated={(code) => onChange({ ...node, data: { ...node.data, code } })}
            />
            <div>
              <label className={labelClass}>{node.data.language === 'python' ? 'Python' : 'JavaScript'}</label>
              <CodeEditor
                value={node.data.code}
                language={node.data.language === 'python' ? 'python' : 'javascript'}
                ariaLabel={node.data.language === 'python' ? 'Python code' : 'JavaScript code'}
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(code) => onChange({ ...node, data: { ...node.data, code } })}
              />
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Return a JSON-compatible value. Use <code>input</code> for this step&apos;s data and <code>context</code> for trigger, steps, variables, time, and run metadata. Imports, files, network calls, and child processes are unavailable.
              </p>
            </div>
            <AdvancedParamsSection node={node} onChange={onChange} defaultOpen />
          </>
        )}

        {node.type === 'note' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Note</label>
              <textarea
                rows={6}
                className={areaClass}
                value={node.data.text}
                placeholder="Document this part of the flow — what it does, gotchas, links…"
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => onChange({ ...node, data: { ...node.data, text: e.target.value } })}
              />
            </div>
            <div>
              <label className={labelClass}>Color</label>
              <select className={fieldClass} value={node.data.color ?? 'yellow'} onChange={(e) => onChange({ ...node, data: { ...node.data, color: e.target.value as 'yellow' | 'blue' | 'green' | 'pink' } })}>
                <option value="yellow">Yellow</option>
                <option value="blue">Blue</option>
                <option value="green">Green</option>
                <option value="pink">Pink</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">A note never runs — it just documents the flow in place.</p>
          </div>
        )}

        {node.type === 'wait' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>Wait for</label>
              <select
                className={fieldClass}
                value={node.data.mode ?? 'duration'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, mode: e.target.value as 'duration' | 'until' | 'webhook' } })}
              >
                <option value="duration">A set amount of time</option>
                <option value="until">Until a specific date/time</option>
                <option value="webhook">An external system to call back</option>
              </select>
            </div>
            {(node.data.mode ?? 'duration') === 'duration' && (
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={labelClass}>Amount</label>
                  <TokenTextEditor
                    ref={registerEditor('wait.amount')}
                    value={node.data.amount ?? ''}
                    labelCtx={labelCtx}
                    placeholder="e.g. 3"
                    onFocus={focusEditor('wait.amount')}
                    onChange={(amount) => onChange({ ...node, data: { ...node.data, amount } })}
                    ariaLabel="Amount to wait"
                  />
                </div>
                <div>
                  <label className={labelClass}>Unit</label>
                  <select
                    className={fieldClass}
                    value={node.data.unit ?? 'minutes'}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, unit: e.target.value as 'seconds' | 'minutes' | 'hours' | 'days' } })}
                  >
                    <option value="seconds">Seconds</option>
                    <option value="minutes">Minutes</option>
                    <option value="hours">Hours</option>
                    <option value="days">Days</option>
                  </select>
                </div>
              </div>
            )}
            {node.data.mode === 'until' && (
              <div>
                <label className={labelClass}>Wait until</label>
                <TokenTextEditor
                  ref={registerEditor('wait.until')}
                  value={node.data.until ?? ''}
                  labelCtx={labelCtx}
                  placeholder="e.g. 2026-08-01T09:00:00Z or pick a date value below"
                  onFocus={focusEditor('wait.until')}
                  onChange={(until) => onChange({ ...node, data: { ...node.data, until } })}
                  ariaLabel="Wait until"
                />
                <div className="mt-2">
                  <DataTree fields={dataFields} onInsert={insertToken} />
                </div>
              </div>
            )}
            {node.data.mode === 'webhook' && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  The run pauses until an external system POSTs to its resume URL. Use the <span className="font-medium">Run resume link</span> value (from the data menu) in a step before this one to hand the URL to that system. The callback body becomes this step&apos;s output.
                </p>
                <div>
                  <label className={labelClass}>Give up after (minutes, optional)</label>
                  <input
                    type="number"
                    min={1}
                    className={fieldClass}
                    placeholder="Wait indefinitely"
                    value={node.data.timeoutMinutes ?? ''}
                    onFocus={blockActive}
                    onBlur={unblockActive}
                    onChange={(e) => {
                      const n = Number(e.target.value)
                      onChange({ ...node, data: { ...node.data, timeoutMinutes: n > 0 ? Math.floor(n) : undefined } })
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        {node.type === 'join' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>How to merge branches</label>
              <select
                className={fieldClass}
                value={node.data.mode ?? 'passthrough'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, mode: e.target.value === 'passthrough' ? undefined : (e.target.value as 'append' | 'combineByKey' | 'combineByPosition' | 'allCombinations') } })}
              >
                <option value="passthrough">Continue on whichever branch ran (merge paths)</option>
                <option value="append">Combine every branch&apos;s items into one list</option>
                <option value="combineByKey">Combine records from every branch by a matching field</option>
                <option value="combineByPosition">Pair up branches item by item, in order</option>
                <option value="allCombinations">Every combination of one item from each branch</option>
              </select>
            </div>
            {(node.data.mode === 'combineByKey' || node.data.mode === 'combineByPosition') && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={node.data.mode === 'combineByPosition' ? node.data.includeUnpaired === true : node.data.includeUnpaired !== false}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, includeUnpaired: e.target.checked } })}
                />
                Keep items that found no match
              </label>
            )}
            {node.data.mode === 'combineByKey' && (
              <div>
                <label className={labelClass}>Matching field</label>
                <input
                  className={fieldClass}
                  value={node.data.key ?? ''}
                  placeholder="e.g. email"
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, key: e.target.value || undefined } })}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">Records from each branch that share this field are merged into one.</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Point the ends of different branches at this step so the steps after it run once. In &quot;merge paths&quot; mode only the branch that ran continues; the combine modes gather every branch that produced data.
            </p>
          </div>
        )}
          </div>

          {!isTrigger && (
            <div className={cn('flex gap-2 border-t border-border', isWorkspace ? 'justify-end bg-slate-50/70 px-6 py-3' : 'p-4')}>
              {onDuplicate && (
                <Button variant="outline" className={isWorkspace ? '' : 'flex-1'} onClick={onDuplicate}>
                  <Copy className="mr-1.5 h-4 w-4" /> Duplicate
                </Button>
              )}
              <Button variant="outline" className={cn('text-red-600 hover:text-red-700', !isWorkspace && 'flex-1')} onClick={onDelete}>
                <Trash2 className="mr-1.5 h-4 w-4" /> Delete
              </Button>
            </div>
          )}
        </div>
        {isWorkspace && (
          <aside className="hidden min-h-0 flex-col border-l border-border bg-slate-50/70 lg:flex">
            <div className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <Braces className="h-4 w-4 text-indigo-600" />
                  <p className="text-sm font-semibold">Output</p>
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {mockData !== undefined ? 'Mock data is pinned — this node is not executed.' : 'Raw output from this node’s latest run.'}
                </p>
              </div>
              {!isTrigger && onSetMockData && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-xs"
                  onClick={() => {
                    if (mockData !== undefined) { onSetMockData(undefined); return }
                    const seed = rawOutput !== undefined ? rawOutput : { example: 'value' }
                    onSetMockData(seed)
                    setMockDraft(JSON.stringify(seed, null, 2))
                  }}
                >
                  <Pin className="mr-1 h-3.5 w-3.5" />
                  {mockData !== undefined ? 'Clear mock' : 'Set mock data'}
                </Button>
              )}
            </div>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              {mockData !== undefined ? (
                <div className="space-y-2">
                  <textarea
                    className="min-h-40 w-full resize-y rounded-lg border border-amber-500/40 bg-graphite-950 p-3 font-mono text-[11px] leading-5 text-graphite-100 outline-none"
                    value={mockDraft}
                    spellCheck={false}
                    onFocus={blockActive}
                    onBlur={() => {
                      unblockActive()
                      try {
                        onSetMockData?.(JSON.parse(mockDraft))
                      } catch {
                        toast.error('Mock data must be valid JSON.')
                      }
                    }}
                    onChange={(event) => setMockDraft(event.target.value)}
                    aria-label="Mock output data"
                  />
                  <p className="text-[11px] leading-4 text-muted-foreground">Edit the pinned JSON, then click away to save. Downstream nodes use this value until you clear the mock.</p>
                </div>
              ) : (
                <>
                  <pre className="min-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-graphite-950 p-3 font-mono text-[11px] leading-5 text-graphite-100">
                    {rawJson(rawOutput, 'No output data yet.\nExecute this step to inspect its response here.')}
                  </pre>
                  {!isTrigger && onExecuteStep && rawOutput === undefined && (
                    <Button type="button" variant="outline" size="sm" className="w-full" onClick={onExecuteStep}>
                      <Play className="mr-1.5 h-4 w-4" /> Execute step
                    </Button>
                  )}
                </>
              )}
              {rawLogs && rawLogs.length > 0 && (
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Logs</p>
                  <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg border border-amber-500/30 bg-amber-950/40 p-3 font-mono text-[11px] leading-5 text-amber-100">
                    {rawLogs.join('\n')}
                  </pre>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
      {node.type === 'http' && (
        <HttpCredentialDialog
          open={credentialDialogOpen}
          onOpenChange={setCredentialDialogOpen}
          requestUrl={node.data.url}
          requestMethod={node.data.method}
          initialAuthType={newCredentialType}
          onSaved={(credential) => {
            setHttpCredentials((current) => [
              credential,
              ...current.filter((entry) => entry.id !== credential.id),
            ])
            onChange({ ...node, data: { ...node.data, credentialId: credential.id, connectionId: undefined } })
          }}
        />
      )}
      {node.type === 'http' && (
        <ImportCurlDialog
          open={curlDialogOpen}
          onOpenChange={setCurlDialogOpen}
          onImport={(parsed) => onChange({
            ...node,
            data: {
              ...node.data,
              ...(parsed.method ? { method: parsed.method } : {}),
              ...(parsed.url ? { url: parsed.url } : {}),
              ...(parsed.headers ? { headers: parsed.headers, sendHeaders: true } : {}),
              ...(parsed.body !== undefined ? { body: parsed.body, sendBody: true } : {}),
              ...(parsed.bodyMode ? { bodyMode: parsed.bodyMode } : {}),
              ...(parsed.followRedirects ? { followRedirects: true } : {}),
            },
          })}
        />
      )}
    </div>
  )
}

type TokenEditorPlumbing = {
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  insertToken: (token: string) => void
  blockActive: () => void
  unblockActive: () => void
}

/** Variable step editor: op, name (a select of upstream initializes for mutations), type, value. */
function VariableEditor({
  node,
  variableNames,
  onChange,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
  blockActive,
  unblockActive,
}: {
  node: Extract<FlowNode, { type: 'variable' }>
  variableNames: string[]
  onChange: (node: FlowNode) => void
} & TokenEditorPlumbing) {
  const isInitialize = node.data.op === 'initialize'
  const currentName = node.data.name.trim()
  // Mutation ops pick from variables initialized earlier; keep a name that is
  // not in that list selectable (it may live in a sibling branch).
  const nameOptions = [...variableNames, ...(currentName && !variableNames.includes(currentName) ? [currentName] : [])]
  const setOp = (op: VariableOp) =>
    onChange({ ...node, data: { ...node.data, op, varType: op === 'initialize' ? node.data.varType ?? 'string' : undefined } })
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass}>Operation</label>
        <select className={fieldClass} value={node.data.op} onChange={(e) => setOp(e.target.value as VariableOp)}>
          {VARIABLE_OPS.map((op) => (
            <option key={op} value={op}>
              {VARIABLE_OP_LABELS[op]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass}>Name</label>
        {isInitialize || nameOptions.length === 0 ? (
          <input
            className={fieldClass}
            value={node.data.name}
            placeholder="Enter variable name"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, name: e.target.value } })}
            aria-label="Variable name"
          />
        ) : (
          <select
            className={fieldClass}
            value={currentName}
            onChange={(e) => onChange({ ...node, data: { ...node.data, name: e.target.value } })}
            aria-label="Variable name"
          >
            <option value="">Choose a variable…</option>
            {nameOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        {!isInitialize && nameOptions.length === 0 && (
          <p className="mt-1.5 text-xs text-muted-foreground">No variables are initialized earlier in this flow — add an Initialize variable step first, or type the name it will use.</p>
        )}
      </div>
      {isInitialize && (
        <div>
          <label className={labelClass}>Type</label>
          <select
            className={fieldClass}
            value={node.data.varType ?? 'string'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, varType: e.target.value as VariableType } })}
          >
            {VARIABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {VARIABLE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
      )}
      <div>
        <label className={labelClass}>Value {variableValueOptional(node.data.op) ? '(optional)' : ''}</label>
        <TokenTextEditor
          ref={registerEditor('var.value')}
          value={node.data.value ?? ''}
          labelCtx={labelCtx}
          placeholder={VARIABLE_VALUE_PLACEHOLDER[node.data.op]}
          onFocus={focusEditor('var.value')}
          onChange={(value) => onChange({ ...node, data: { ...node.data, value } })}
          ariaLabel="Variable value"
        />
        <div className="mt-2">
          <DataTree fields={dataFields} onInsert={insertToken} />
        </div>
      </div>
    </div>
  )
}

/** Data operation step editor: op, input, and the op-specific extras. */
function DataEditor({
  node,
  onChange,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
  blockActive,
  unblockActive,
}: {
  node: Extract<FlowNode, { type: 'data' }>
  onChange: (node: FlowNode) => void
} & TokenEditorPlumbing) {
  const op = node.data.op
  const clauses = node.data.clauses?.length ? node.data.clauses : [{ left: '', op: 'contains' as ConditionOp, right: '' }]
  const fields = node.data.fields?.length ? node.data.fields : [{ name: '', value: '' }]
  const setOp = (next: DataOp) => {
    // Ops with required list config start with one empty row so the editor
    // opens ready to fill in.
    const nextClauses = next === 'filterArray' && !(node.data.clauses ?? []).length ? [{ left: '', op: 'contains' as ConditionOp, right: '' }] : node.data.clauses
    const nextFields = (next === 'select' || next === 'compose') && !(node.data.fields ?? []).length ? [{ name: '', value: '' }] : node.data.fields
    onChange({ ...node, data: { ...node.data, op: next, clauses: nextClauses, fields: nextFields } })
  }
  const setClauses = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next } })
  const setFields = (next: { name: string; value: string }[]) => onChange({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass}>Operation</label>
        <select className={fieldClass} value={op} onChange={(e) => setOp(e.target.value as DataOp)}>
          {DATA_OPS.map((entry) => (
            <option key={entry} value={entry}>
              {DATA_OP_LABELS[entry]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass}>Input</label>
        <TokenTextEditor
          ref={registerEditor('data.input')}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          placeholder={DATA_OP_INPUT_PLACEHOLDER[op]}
          onFocus={focusEditor('data.input')}
          onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
          ariaLabel="Input"
        />
      </div>
      {(op === 'join' || op === 'split') && (
        <div>
          <label className={labelClass}>{op === 'join' ? 'Join with (optional)' : 'Split at (optional)'}</label>
          <input
            className={fieldClass}
            value={node.data.separator ?? ''}
            placeholder="Defaults to a comma"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, separator: e.target.value || undefined } })}
            aria-label={op === 'join' ? 'Join with' : 'Split at'}
          />
        </div>
      )}
      {op === 'replace' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass}>Find</label>
            <input
              className={fieldClass}
              value={node.data.find ?? ''}
              placeholder="Text to find"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, find: e.target.value || undefined } })}
              aria-label="Find"
            />
          </div>
          <div>
            <label className={labelClass}>Replace with</label>
            <input
              className={fieldClass}
              value={node.data.replaceWith ?? ''}
              placeholder="Leave empty to remove it"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, replaceWith: e.target.value || undefined } })}
              aria-label="Replace with"
            />
          </div>
        </div>
      )}
      {op === 'getItem' && (
        <div>
          <label className={labelClass}>Position</label>
          <input
            className={fieldClass}
            value={node.data.index ?? ''}
            placeholder="0 is the first item; -1 is the last"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, index: e.target.value || undefined } })}
            aria-label="Position"
          />
        </div>
      )}
      {op === 'trim' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass}>Items to remove</label>
            <input
              className={fieldClass}
              value={node.data.count ?? ''}
              placeholder="Defaults to 1"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, count: e.target.value || undefined } })}
              aria-label="Items to remove"
            />
          </div>
          <div>
            <label className={labelClass}>From</label>
            <select
              className={fieldClass}
              value={node.data.fromEnd ? 'end' : 'start'}
              onChange={(e) => onChange({ ...node, data: { ...node.data, fromEnd: e.target.value === 'end' ? true : undefined } })}
              aria-label="Trim from"
            >
              <option value="start">The start</option>
              <option value="end">The end</option>
            </select>
          </div>
        </div>
      )}
      {op === 'parseJson' && (
        <div>
          <label className={labelClass}>Schema (optional)</label>
          <textarea
            rows={4}
            className={`${areaClass} font-mono text-xs`}
            value={node.data.schema ?? ''}
            placeholder="A JSON Schema describing the parsed shape"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, schema: e.target.value || undefined } })}
            aria-label="Schema"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">Optional — stored for reference.</p>
        </div>
      )}
      {op === 'filterArray' && (
        <div className="space-y-3">
          <label className={labelClass}>Conditions</label>
          {clauses.map((clause, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
              <TokenTextEditor
                ref={registerEditor(`data.clause.${i}.left`)}
                className="px-2 py-1.5"
                value={clause.left}
                labelCtx={labelCtx}
                placeholder="Item field to check"
                onFocus={focusEditor(`data.clause.${i}.left`)}
                onChange={(left) => setClauses(clauses.map((c, j) => (j === i ? { ...c, left } : c)))}
                ariaLabel={`Condition ${i + 1} value`}
              />
              <div className="flex gap-1.5">
                <select className={smallField} value={clause.op} onChange={(e) => setClauses(clauses.map((c, j) => (j === i ? { ...c, op: e.target.value as ConditionOp } : c)))}>
                  {CONDITION_OPS.map((entry) => (
                    <option key={entry} value={entry}>
                      {CONDITION_OP_LABELS[entry]}
                    </option>
                  ))}
                </select>
                <TokenTextEditor
                  ref={registerEditor(`data.clause.${i}.right`)}
                  className="min-w-0 flex-1 px-2 py-1.5"
                  value={clause.right}
                  labelCtx={labelCtx}
                  placeholder="Compare to"
                  onFocus={focusEditor(`data.clause.${i}.right`)}
                  onChange={(right) => setClauses(clauses.map((c, j) => (j === i ? { ...c, right } : c)))}
                  ariaLabel={`Condition ${i + 1} comparison value`}
                />
                {clauses.length > 1 && (
                  <button type="button" onClick={() => setClauses(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove condition">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={() => setClauses([...clauses, { left: '', op: 'contains', right: '' }])}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add condition
          </button>
          <p className="text-[11px] text-muted-foreground">Every condition checks one item of the list at a time; only items where all conditions pass are kept.</p>
        </div>
      )}
      {(op === 'sort' || op === 'removeDuplicates' || op === 'summarize') && (
        <div>
          <label className={labelClass}>{op === 'summarize' ? 'Group by field' : 'Field'}</label>
          <input
            className={fieldClass}
            value={node.data.by ?? ''}
            placeholder={op === 'summarize' ? 'Leave empty to summarize the whole list' : 'Leave empty to use the whole item'}
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, by: e.target.value } })}
          />
        </div>
      )}
      {op === 'sort' && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={node.data.descending === true}
            onChange={(e) => onChange({ ...node, data: { ...node.data, descending: e.target.checked || undefined } })}
          />
          Highest first
        </label>
      )}
      {op === 'limit' && (
        <>
          <div>
            <label className={labelClass}>How many to keep</label>
            <input
              className={fieldClass}
              value={node.data.count ?? ''}
              placeholder="10"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, count: e.target.value } })}
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={node.data.fromEnd === true}
              onChange={(e) => onChange({ ...node, data: { ...node.data, fromEnd: e.target.checked || undefined } })}
            />
            Take from the end of the list
          </label>
        </>
      )}
      {op === 'aggregate' && (
        <div>
          <label className={labelClass}>Field to collect</label>
          <input
            className={fieldClass}
            value={node.data.by ?? ''}
            placeholder="Leave empty to keep the whole list as one value"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, by: e.target.value } })}
          />
        </div>
      )}
      {op === 'summarize' && (
        <div className="space-y-2">
          <label className={labelClass}>Calculate</label>
          {(node.data.aggregations ?? [{ field: '', op: 'sum' as const }]).map((entry, i) => {
            const rows = node.data.aggregations ?? [{ field: '', op: 'sum' as const }]
            const setRows = (next: typeof rows) => onChange({ ...node, data: { ...node.data, aggregations: next } })
            return (
              <div key={i} className="flex gap-1.5">
                <select
                  className={`${smallField} w-28`}
                  value={entry.op}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, op: e.target.value as typeof r.op } : r)))}
                >
                  {(['sum', 'avg', 'count', 'min', 'max'] as const).map((o) => (
                    <option key={o} value={o}>{SUMMARIZE_OP_LABELS[o]}</option>
                  ))}
                </select>
                <input
                  className={`${smallField} flex-1`}
                  value={entry.field}
                  placeholder="of field"
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => setRows(rows.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)))}
                />
                {rows.length > 1 && (
                  <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove calculation">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            onClick={() => onChange({ ...node, data: { ...node.data, aggregations: [...(node.data.aggregations ?? [{ field: '', op: 'sum' as const }]), { field: '', op: 'sum' as const }] } })}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add calculation
          </button>
        </div>
      )}
      {(op === 'select' || op === 'compose') && (
        <div className="space-y-3">
          <label className={labelClass}>Fields</label>
          {fields.map((field, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
              <div className="flex gap-1.5">
                <input
                  className={`${smallField} flex-1`}
                  value={field.name}
                  placeholder="Output field"
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => setFields(fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
                />
                {fields.length > 1 && (
                  <button type="button" onClick={() => setFields(fields.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove field">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              <TokenTextEditor
                ref={registerEditor(`data.field.${i}.value`)}
                className="px-2 py-1.5"
                value={field.value}
                labelCtx={labelCtx}
                placeholder="Value for this field"
                onFocus={focusEditor(`data.field.${i}.value`)}
                onChange={(value) => setFields(fields.map((f, j) => (j === i ? { ...f, value } : f)))}
                ariaLabel={`Value for field ${field.name || i + 1}`}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFields([...fields, { name: '', value: '' }])}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" /> Add field
          </button>
        </div>
      )}
      <div>
        <DataTree fields={dataFields} onInsert={insertToken} />
      </div>
      <p className="text-xs text-muted-foreground">{DATA_OP_HELPER[op]}</p>
    </div>
  )
}

/** Value shapes an Output node's named result can declare. */
const OUTPUT_VALUE_TYPES: { value: 'text' | 'list' | 'any'; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'text', label: 'Text' },
  { value: 'list', label: 'List' },
]

type OutputRow = { name: string; value: string; type?: 'text' | 'list' | 'any' }

/** Output step editor: repeatable named results (name / templated value / type). */
function OutputEditor({
  node,
  onChange,
  dataFields,
  labelCtx,
  registerEditor,
  focusEditor,
  insertToken,
  blockActive,
  unblockActive,
}: {
  node: Extract<FlowNode, { type: 'output' }>
  onChange: (node: FlowNode) => void
} & TokenEditorPlumbing) {
  const outputs: OutputRow[] = node.data.outputs.length ? node.data.outputs : [{ name: 'output', value: '', type: 'any' }]
  const setOutputs = (next: OutputRow[]) => onChange({ ...node, data: { ...node.data, outputs: next } })
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Return one or more named results to whatever called this flow — the webhook response, the completion signal, or a parent flow.</p>
      {outputs.map((row, i) => (
        <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
          <div className="flex gap-1.5">
            <input
              className={`${smallField} flex-1`}
              value={row.name}
              placeholder="resultName"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => setOutputs(outputs.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))}
              aria-label="Output name"
            />
            <select
              className={smallField}
              value={row.type ?? 'any'}
              onChange={(e) => setOutputs(outputs.map((r, j) => (j === i ? { ...r, type: e.target.value as OutputRow['type'] } : r)))}
              aria-label="Output type"
            >
              {OUTPUT_VALUE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            {outputs.length > 1 && (
              <button type="button" onClick={() => setOutputs(outputs.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove output">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
          <TokenTextEditor
            ref={registerEditor(`out.${i}.value`)}
            className="px-2 py-1.5"
            value={row.value}
            labelCtx={labelCtx}
            placeholder="Value to return — choose data from below"
            onFocus={focusEditor(`out.${i}.value`)}
            onChange={(value) => setOutputs(outputs.map((r, j) => (j === i ? { ...r, value } : r)))}
            ariaLabel={`Value for output ${row.name || i + 1}`}
          />
        </div>
      ))}
      <button
        type="button"
        onClick={() => setOutputs([...outputs, { name: '', value: '', type: 'any' }])}
        className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
      >
        <Plus className="h-3.5 w-3.5" /> Add output
      </button>
      <div>
        <DataTree fields={dataFields} onInsert={insertToken} />
      </div>
    </div>
  )
}

/** Declare a step's output fields so downstream steps can map from them. */
function OutputFieldsEditor({
  fields,
  onChange,
  blockActive,
  unblockActive,
}: {
  fields: OutputField[]
  onChange: (fields: OutputField[]) => void
  blockActive: () => void
  unblockActive: () => void
}) {
  return (
    <div>
      <label className={labelClass}>Output fields (optional)</label>
      <p className="-mt-1 mb-2 text-[11px] text-muted-foreground">Declare what this step returns so later steps can map its fields. Fields also appear once the step has run.</p>
      <div className="space-y-1.5">
        {fields.map((field, i) => (
          <div key={i} className="flex gap-1.5">
            <input
              className={`${smallField} flex-1`}
              value={field.name}
              placeholder="fieldName"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
            />
            <select className={smallField} value={field.type} onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, type: e.target.value as OutputField['type'] } : f)))}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove field">
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...fields, { name: '', type: 'any' }])} className="mt-1.5 flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
        <Plus className="h-3.5 w-3.5" /> Add field
      </button>
    </div>
  )
}

/** The subflow step's settings: pick a workspace flow, map its declared
 * inputs (or the free-form fallback), with a publish-state nudge. */
function SubflowDrawerSection({
  node,
  onChange,
  flowId,
  labelCtx,
  registerEditor,
  focusEditor,
  dataFields,
  insertToken,
}: {
  node: Extract<FlowNode, { type: 'subflow' }>
  onChange: (node: FlowNode) => void
  flowId: string
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  dataFields: DataField[]
  insertToken: (token: string) => void
}) {
  const { flows, loading } = useWorkspaceFlows()
  const selectable = flows.filter((flow) => flow.id !== flowId)
  const selected = flows.find((flow) => flow.id === node.data.flowId)
  const childFields = (selected?.inputFields ?? []).filter((field) => field.name.trim())
  const inputs = node.data.inputs ?? {}
  const setInput = (name: string, value: string) => {
    const next = { ...inputs, [name]: value }
    if (!value) delete next[name]
    onChange({ ...node, data: { ...node.data, inputs: Object.keys(next).length ? next : undefined } })
  }
  return (
    <>
      <div>
        <label className={labelClass}>Flow to run</label>
        <select
          className={fieldClass}
          value={node.data.flowId}
          onChange={(e) => onChange({ ...node, data: { ...node.data, flowId: e.target.value, inputs: undefined } })}
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
          <p className="mt-1.5 text-xs text-amber-600">This flow has never been published — publish it before running it from here.</p>
        )}
      </div>
      {childFields.length > 0 ? (
        <div className="space-y-2">
          <label className={labelClass}>Inputs it expects</label>
          {childFields.map((field) => (
            <div key={field.name}>
              <p className="mb-1 text-[11px] font-medium text-muted-foreground">{field.name}{field.required ? ' (required)' : ''}</p>
              <TokenTextEditor
                ref={registerEditor(`subflow.${field.name}`)}
                className="px-2 py-1.5"
                value={inputs[field.name] ?? ''}
                labelCtx={labelCtx}
                placeholder={field.description || 'Add a value or pick flow data'}
                onFocus={focusEditor(`subflow.${field.name}`)}
                onChange={(value) => setInput(field.name, value)}
                ariaLabel={`Value for ${field.name}`}
              />
            </div>
          ))}
        </div>
      ) : (
        <div>
          <label className={labelClass}>Input to send it</label>
          <TokenTextEditor
            ref={registerEditor('subflow.input')}
            multiline
            rows={3}
            value={node.data.input ?? ''}
            labelCtx={labelCtx}
            placeholder="What the flow receives as its run input."
            onFocus={focusEditor('subflow.input')}
            onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
            ariaLabel="Input to send the flow"
          />
        </div>
      )}
      <div className="mt-2">
        <DataTree fields={dataFields} onInsert={insertToken} />
      </div>
      <p className="text-xs text-muted-foreground">Runs the flow&apos;s <strong>published</strong> version and passes its result to later steps.</p>
      <AdvancedParamsSection node={node} onChange={onChange} />
    </>
  )
}

/** Declare the payload fields a manual/scheduled/webhook trigger expects. */
function InputFieldsEditor({ fields, onChange }: { fields: TriggerInputField[]; onChange: (fields: TriggerInputField[]) => void }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
      <label className={labelClass}>Expected input fields</label>
      <p className="-mt-1 mb-2 text-[11px] text-muted-foreground">
        Name the values this flow expects. Downstream steps can pick them as Run input fields instead of typing template paths.
      </p>
      <div className="space-y-2">
        {fields.map((field, i) => (
          <div key={i} className="space-y-1.5 rounded-lg border border-border bg-background p-2">
            <div className="flex gap-1.5">
              <input
                className={`${smallField} min-w-0 flex-1`}
                value={field.name}
                placeholder="account"
                onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
              />
              <select className={smallField} value={field.type} onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, type: e.target.value as OutputField['type'] } : f)))}>
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => onChange(fields.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove input field">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <input
              className={`${smallField} w-full`}
              value={field.description ?? ''}
              placeholder="What should the user or webhook send here?"
              onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, description: e.target.value || undefined } : f)))}
            />
            <input
              className={`${smallField} w-full`}
              value={field.default ?? ''}
              placeholder="Default value if none is provided"
              onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, default: e.target.value || undefined } : f)))}
              aria-label="Default value"
            />
            <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <input
                type="checkbox"
                checked={field.required === true}
                onChange={(e) => onChange(fields.map((f, j) => (j === i ? { ...f, required: e.target.checked || undefined } : f)))}
                className="h-3.5 w-3.5 rounded border-border"
              />
              Required — the run must supply this value
            </label>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => onChange([...fields, { name: '', type: 'string' }])} className="mt-2 flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
        <Plus className="h-3.5 w-3.5" /> Add input field
      </button>
    </div>
  )
}
