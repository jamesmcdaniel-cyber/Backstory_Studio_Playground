'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { indentOnTab } from '@/components/ui/textarea'
import { X, Trash2, Plus, Copy, Database, Settings2, Braces, ChevronLeft, ChevronRight, KeyRound, TerminalSquare, Play, Pin, AlertTriangle, ToggleLeft, ToggleRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { AI_OPS, AI_OP_LABELS, UNARY_CONDITION_OPS, CONDITION_OP_LABELS, DATA_OPS, FIELD_TYPES, VARIABLE_OPS, VARIABLE_OP_LABELS, VARIABLE_TYPES, VARIABLE_TYPE_LABELS, type AiOp, type FlowNode, type ConditionOp, type ConditionClause, type DataOp, type FieldType, type OutputField, type TriggerInputField, type VariableOp, type VariableType } from '@/lib/flows/graph'
import { DATA_OP_LABELS } from '@/lib/flows/data-ops'
import { DATA_OP_HELPER, DATA_OP_INPUT_PLACEHOLDER, SUMMARIZE_OP_LABELS, SUMMARIZE_OPS, VARIABLE_VALUE_PLACEHOLDER, variableValueOptional } from '@/lib/flows/step-copy'
import { useDismissOnOutsidePointer } from '@/hooks/use-dismiss-on-outside-pointer'
import { DataTree } from '@/components/flows/data-tree'
import { StructuredValueView } from '@/components/flows/structured-value-view'
import { ToolArgsEditor, schemaFields } from '@/components/flows/tool-args-editor'
import { pruneArgLabels } from '@/lib/flows/resource-locator'
import { fileBindingOptions, type DataField } from '@/lib/flows/datatree'
import { splitIssuesByField, type FieldIssue } from '@/lib/flows/issue-fields'
import { mcpStepSuggestion } from '@/lib/flows/mcp-step-suggestion'
import { operatorsForField } from '@/lib/flows/condition-ops'
import { NodeOptions } from '@/components/flows/node-options'
import { PanelNotice } from '@/components/flows/panel-notice'
import type { NodeOption } from '@/lib/flows/node-options'
import { CodeEditor } from '@/components/flows/code-editor'
import { CodeAssist } from '@/components/flows/code-assist'
import { TokenTextEditor, type TokenTextEditorHandle } from '@/components/flows/token-text-editor'
import type { TokenLabelContext } from '@/lib/flows/token-text'
import type { FlowContext } from '@/features/flows/context'
import type { FormFileBinding } from '@/lib/flows/file-ref'
import { cn } from '@/lib/utils'
import { TriggerEditor, type TriggerData } from './trigger-editor'
import { AgentInlineCreate } from './agent-inline-create'
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
  { value: 'subflow', label: 'Execute Sub-workflow' },
  { value: 'knowledge', label: 'Search knowledge' },
  { value: 'code', label: 'Code' },
  { value: 'tool', label: 'Tool call' },
  { value: 'http', label: 'HTTP Request' },
  { value: 'transform', label: 'Edit Fields (Set)' },
  { value: 'data', label: 'Data operation' },
  { value: 'variable', label: 'Variable' },
  { value: 'humanReview', label: 'Request information' },
  { value: 'condition', label: 'If' },
  { value: 'switch', label: 'Switch' },
  { value: 'filter', label: 'Filter' },
  { value: 'loop', label: 'Loop Over Items (Split in Batches)' },
  { value: 'parallel', label: 'Parallel' },
  { value: 'output', label: 'Output' },
  { value: 'join', label: 'Merge' },
  { value: 'stop', label: 'Stop and Error' },
]

export type ToolCatalog = { id: string; name: string; serverUrl?: string; tools: { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown }[]; toolsError?: string }[]

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

/** Curated chat models for the agent step's per-step override; a free-typed
 * value saved earlier stays selectable. */
export const AGENT_STEP_MODELS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5']

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
  const uid = useId()
  const perItem = (node.data as { perItem?: PerItemConfigLike }).perItem
  const enabled = Boolean(perItem)
  const patch = (next: PerItemConfigLike | undefined) => onChange({ ...node, data: { ...node.data, perItem: next } } as FlowNode)
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <label className={labelClass} htmlFor={`${uid}-per-item-mode`}>Run this step</label>
      <select
        id={`${uid}-per-item-mode`}
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
            <span className={labelClass}>For each item in</span>
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
            <label className={labelClass} htmlFor={`${uid}-per-item-error`}>If an item fails</label>
            <select
              id={`${uid}-per-item-error`}
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
            <label className={labelClass} htmlFor={`${uid}-per-item-concurrency`}>At a time</label>
            <input
              id={`${uid}-per-item-concurrency`}
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

/**
 * Multipart FILE fields on an HTTP step: bind a form field name to a file an
 * earlier step produced (a download, an upload on the run input, a subflow
 * result). The source is PICKED from the same data menu the rest of the builder
 * uses — the stored value is a plain path and the user never sees or types
 * token syntax.
 */
function FormFileFields({
  bindings,
  options,
  onChange,
}: {
  bindings: FormFileBinding[]
  options: { label: string; path: string }[]
  onChange: (bindings: FormFileBinding[] | undefined) => void
}) {
  const update = (next: FormFileBinding[]) => onChange(next.length ? next : undefined)
  const setAt = (index: number, patch: Partial<FormFileBinding>) =>
    update(bindings.map((binding, i) => (i === index ? { ...binding, ...patch } : binding)))

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">File attachments</p>
          <p className="text-xs text-muted-foreground">
            Send a file from an earlier step as a real upload — its original name and type travel with it.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={options.length === 0 || bindings.length >= 10}
          onClick={() => update([...bindings, { field: bindings.length ? `file${bindings.length + 1}` : 'file', source: options[0]?.path ?? '' }])}
        >
          <Plus className="mr-1 h-3.5 w-3.5" /> Add file
        </Button>
      </div>
      {options.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No earlier step produces a file yet. Add a step that downloads or receives one, then attach it here.
        </p>
      ) : (
        bindings.map((binding, index) => (
          <div key={index} className="flex items-end gap-2">
            <div className="w-40 shrink-0">
              <label className={labelClass} htmlFor={`http-file-field-${index}`}>Form field</label>
              <input
                id={`http-file-field-${index}`}
                className={fieldClass}
                value={binding.field}
                placeholder="file"
                onChange={(event) => setAt(index, { field: event.target.value })}
              />
            </div>
            <div className="min-w-0 flex-1">
              <label className={labelClass} htmlFor={`http-file-source-${index}`}>File from</label>
              <select
                id={`http-file-source-${index}`}
                className={fieldClass}
                value={binding.source}
                onChange={(event) => setAt(index, { source: event.target.value })}
              >
                {!options.some((option) => option.path === binding.source) && (
                  <option value={binding.source}>{binding.source ? 'Step that no longer exists' : 'Choose a file…'}</option>
                )}
                {options.map((option) => (
                  <option key={option.path} value={option.path}>{option.label}</option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className="mb-1.5 rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => update(bindings.filter((_, i) => i !== index))}
              aria-label={`Remove file attachment ${index + 1}`}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))
      )}
    </div>
  )
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
/**
 * The validation findings one control owns, rendered directly beneath it.
 *
 * Errors read red and warnings amber, matching the checker, so the same
 * finding looks the same wherever the user meets it.
 */
function FieldIssues({ issues }: { issues: FieldIssue[] | undefined }) {
  if (!issues?.length) return null
  return (
    <ul className="mt-1.5 space-y-1" data-field-issues>
      {issues.map((issue, index) => (
        <li
          key={index}
          className={cn(
            'flex items-start gap-1.5 text-xs',
            issue.level === 'error' ? 'text-red-700' : 'text-amber-700',
          )}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="min-w-0">{issue.message}</span>
        </li>
      ))}
    </ul>
  )
}

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
  issueFor,
  onChange,
}: {
  node: Extract<FlowNode, { type: 'tool' }>
  toolCatalog: ToolCatalog
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  /** The step's findings, looked up by the field each control owns. */
  issueFor: (field: string) => FieldIssue[] | undefined
  onChange: (node: FlowNode) => void
}) {
  const uid = useId()
  const { connection, tool, brand, actionLabel } = selectedToolPresentation(
    toolCatalog,
    node.data.connectionId,
    node.data.toolName,
  )
  // An MCP connection is a SERVER exposing TOOLS — n8n's words, and the ones
  // the schema and the protocol use. "Connector / Action / Arguments" is our
  // vocabulary for app integrations, and reading it on a step that calls an MCP
  // server makes the same call look like a different kind of thing.
  const plane = node.data.connectionId ? parseFlowToolConnectionId(node.data.connectionId).plane : null
  const isMcp = plane === 'mcp' || plane === 'people_ai'
  const vocab = isMcp
    ? { picker: 'Server', action: 'Tool', args: 'Values to send', change: 'Change server' }
    : { picker: 'Connector', action: 'Action', args: 'Arguments', change: 'Change app' }
  const providerGroups = groupToolConnections(toolCatalog)
  // Every MCP-plane connection, for the Credential picker; and how this one
  // authenticates, read off the connection rather than asked for again.
  const mcpConnections = toolCatalog.filter((entry) => {
    const entryPlane = parseFlowToolConnectionId(entry.id).plane
    return entryPlane === 'mcp' || entryPlane === 'people_ai'
  })
  const mcpAuthLabel = plane === 'people_ai' ? 'MCP OAuth2' : 'Connected server credential'
  const actions = connection ? toolActionChoices(toolCatalog, connection) : []
  const selectedAction = actions.find(
    (choice) => choice.connectionId === node.data.connectionId && choice.tool.name === node.data.toolName,
  )
  return (
    <div className="space-y-3">
      {!connection ? (
        <div>
          <label className={labelClass} htmlFor={`${uid}-connector`}>Connector</label>
          <select
            id={`${uid}-connector`}
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
          <FieldIssues issues={issueFor('connectionId')} />
        </div>
      ) : (
        <>
          {isMcp ? (
            /* n8n's MCP panel, row for row: Server Transport, MCP Endpoint URL,
               Authentication, Credential, then Tool / Input Mode / Values to
               Send below. The first three are properties of the connection
               rather than of this step, so they are shown and not edited — you
               change them where the connection is configured, and seeing them
               here beats leaving the panel to find out which endpoint a step
               talks to. */
            <>
              <div>
                <label className={labelClass} htmlFor={`${uid}-mcp-transport`}>Server Transport</label>
                <select id={`${uid}-mcp-transport`} className={fieldClass} value="httpStreamable" disabled>
                  <option value="httpStreamable">HTTP Streamable</option>
                </select>
              </div>
              <div>
                <label className={labelClass} htmlFor={`${uid}-mcp-endpoint`}>MCP Endpoint URL</label>
                <input
                  id={`${uid}-mcp-endpoint`}
                  className={`${fieldClass} bg-muted/40`}
                  value={connection.serverUrl ?? ''}
                  readOnly
                  placeholder="Set on the connection"
                />
              </div>
              <div>
                <label className={labelClass} htmlFor={`${uid}-mcp-auth`}>Authentication</label>
                <input id={`${uid}-mcp-auth`} className={`${fieldClass} bg-muted/40`} value={mcpAuthLabel} readOnly />
              </div>
              <div>
                <label className={labelClass} htmlFor={`${uid}-mcp-credential`}>Credential for MCP API</label>
                <div className="flex gap-2">
                  <select
                    id={`${uid}-mcp-credential`}
                    className={`${fieldClass} min-w-0 flex-1`}
                    value={node.data.connectionId}
                    onChange={(event) => onChange({ ...node, data: { ...node.data, connectionId: event.target.value, toolName: '', args: '{}' } })}
                  >
                    {mcpConnections.map((entry) => (
                      <option key={entry.id} value={entry.id}>{entry.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => onChange({ ...node, data: { ...node.data, connectionId: '', toolName: '', args: '{}' } })}
                    className="shrink-0 text-xs font-semibold text-indigo-600 hover:text-indigo-700"
                  >
                    {vocab.change}
                  </button>
                </div>
              </div>
            </>
          ) : (
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
                {vocab.change}
              </button>
            </div>
          )}
          <div>
            <label className={labelClass} htmlFor={`${uid}-action`}>{vocab.action}</label>
            <select
              id={`${uid}-action`}
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
            <FieldIssues issues={issueFor('toolName')} />
            <FieldIssues issues={issueFor('connectionId')} />
          </div>
          {tool && (
            <>
              {tool.description && <p className="text-xs text-muted-foreground">{tool.description}</p>}
              {isMcp && (
                <div>
                  <label className={labelClass} htmlFor={`${uid}-mcp-input-mode`}>Input Mode</label>
                  <select id={`${uid}-mcp-input-mode`} className={fieldClass} value="manual" disabled>
                    <option value="manual">Manual</option>
                  </select>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Values are filled in below. Letting the step&apos;s agent choose them is what an Agent step is for.
                  </p>
                </div>
              )}
              <ToolArgsEditor
                inputSchema={tool.inputSchema}
                args={node.data.args}
                // Pruned on the way in: switching this step to a different tool
                // leaves labels for fields the new tool does not have, and a
                // kept one would resurface naming a record from another system.
                argLabels={pruneArgLabels(node.data.argLabels, schemaFields(tool.inputSchema))}
                onChange={(args) => onChange({ ...node, data: { ...node.data, args } })}
                onChangeLabels={(argLabels) => onChange({ ...node, data: { ...node.data, argLabels } })}
                dataFields={dataFields}
                labelCtx={labelCtx}
                connectionId={node.data.connectionId}
                pickerTools={Array.from(new Set(actions.map((entry) => entry.tool.name)))}
                argsLabel={vocab.args}
              />
              <FieldIssues issues={issueFor('toolArgs')} />
            </>
          )}
        </>
      )}

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
  rawInputInferred,
  rawOutput,
  rawLogs,
  mockData,
  layout = 'drawer',
  navigation,
  onNavigate,
  onRefreshAgents,
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
  issues?: FieldIssue[]
  published?: boolean
  onFlowPersisted?: (updatedAt: string) => void
  rawInput?: unknown
  /** True when rawInput was inferred (parent outputs / run input) rather than
   * read off the recorded step row — the pane labels it so a debugging user
   * knows they are not looking at ground truth. */
  rawInputInferred?: boolean
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
  /** Re-fetch the agents list after an inline agent create, so the select shows the new agent's title. */
  onRefreshAgents?: () => void
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
  const uid = useId()
  const isWorkspace = layout === 'workspace'
  // Findings split into the ones a control owns and the ones that belong to
  // the step as a whole. `issueFor` is what each control calls to claim its own.
  const { byField: fieldIssues, rest: bannerIssues } = useMemo(() => splitIssuesByField(issues), [issues])
  const issueFor = (field: string) => fieldIssues.get(field)
  const issueCount = fieldIssues.size
  const defaultStepName = (() => {
    const base = NODE_TYPES.find((entry) => entry.value === node.type)?.label ?? node.type
    // A tool step bound to an MCP server is an MCP request. Calling it "Tool
    // call" is technically true and tells the reader nothing about which of the
    // two very different things on this canvas they are looking at.
    if (node.type !== 'tool') return base
    const bound = (node.data as { connectionId?: string }).connectionId
    if (!bound) return base
    const { plane } = parseFlowToolConnectionId(bound)
    return plane === 'mcp' || plane === 'people_ai' ? 'MCP request' : base
  })()
  // Connected MCP servers, for spotting an HTTP step that is really an MCP call.
  const mcpSuggestion = useMemo(
    () => mcpStepSuggestion(node as { type: string; data: Record<string, unknown> }, groupToolConnections(toolCatalog).flatMap((group) => group.connections)),
    [node, toolCatalog],
  )
  const [httpCredentials, setHttpCredentials] = useState<HttpCredentialSummary[]>([])
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false)
  const [newCredentialType, setNewCredentialType] = useState<HttpAuthOption>('basic')
  const [curlDialogOpen, setCurlDialogOpen] = useState(false)
  const [reverifyingCredential, setReverifyingCredential] = useState(false)
  const [mobileWorkspaceTab, setMobileWorkspaceTab] = useState<'input' | 'configure' | 'output'>('configure')
  const [inputView, setInputView] = useState<'schema' | 'json'>('schema')
  // Editable draft of the pinned mock JSON. Reset from the graph's pinData when
  // the selected node changes; in-node edits are owned by the textarea/handlers.
  const [mockDraft, setMockDraft] = useState('')
  useEffect(() => {
    setMockDraft(mockData === undefined ? '' : JSON.stringify(mockData, null, 2))
    setMobileWorkspaceTab('configure')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])

  // HTTP auth: a two-way selector (Predefined / Generic) — zero-auth requests
  // are not offered; every HTTP step authenticates. The mode is derived from
  // what the node already binds, with a local override so a user can pick
  // "Generic" and see the auth-type sub-select before a credential exists.
  // Reset when the selected node changes.
  const [httpAuthMode, setHttpAuthMode] = useState<'predefined' | 'generic'>('generic')
  // Predefined credentials reuse connected integrations. Only MCP-plane
  // connections carry a token the HTTP executor can inject, so filter to those.
  const predefinedConnections = useMemo(
    () => groupToolConnections(toolCatalog)
      .flatMap((group) => group.connections)
      .filter((connection) => parseFlowToolConnectionId(connection.id).plane === 'mcp'),
    [toolCatalog],
  )
  // Upstream data a multipart file field can be bound to — objects only, since
  // a file arrives as a file reference. Same source as the data menu, so the
  // picker and the chips always agree.
  const fileOptions = useMemo(() => fileBindingOptions(dataFields), [dataFields])
  useEffect(() => {
    if (node.type !== 'http') return
    // An unbound step starts on whichever mode can actually finish here:
    // reuse a connected integration when one exists, otherwise set up a
    // credential for the host.
    setHttpAuthMode(
      node.data.connectionId ? 'predefined'
        : node.data.credentialId ? 'generic'
          : predefinedConnections.length ? 'predefined' : 'generic',
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id])
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
    fetch('/api/http-credentials?scope=bindable', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (data?.success && Array.isArray(data.credentials)) setHttpCredentials(data.credentials)
      })
      .catch(() => undefined)
  }, [node.type])


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
      <div className={cn('flex items-center justify-between gap-3 overflow-x-auto border-b border-border', isWorkspace ? 'px-4 py-3 sm:px-6 sm:py-4' : 'px-4 py-3')}>
        <div className="flex min-w-0 items-center gap-3">
          {isWorkspace && (
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">
              <Settings2 className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0">
            {isTrigger ? (
              <h2 className={cn('font-semibold', isWorkspace ? 'text-base' : 'text-sm')}>Configure trigger</h2>
            ) : (
              // Editable in place. The name was settable only from the canvas
              // card's overflow menu, which meant the panel you configure a
              // step in was the one place you could not name it — and a flow of
              // "HTTP request, HTTP request, HTTP request" is unreadable on the
              // canvas and in every run log downstream of it.
              <input
                className={cn(
                  'w-full truncate rounded-md border border-transparent bg-transparent font-semibold outline-none',
                  'hover:border-border focus:border-indigo-500 focus:bg-white focus:ring-2 focus:ring-indigo-100',
                  isWorkspace ? '-ml-2 px-2 py-0.5 text-base' : '-ml-1.5 px-1.5 py-0.5 text-sm',
                )}
                value={(node.data as { label?: string }).label ?? ''}
                placeholder={defaultStepName}
                aria-label="Step name"
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(event) => onChange({
                  ...node,
                  data: { ...node.data, label: event.target.value || undefined },
                } as FlowNode)}
              />
            )}
            {isWorkspace && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isTrigger ? 'Trigger settings' : `${defaultStepName} · Parameters`}
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

      {isWorkspace && (
        <div className="grid shrink-0 grid-cols-3 border-b border-border bg-slate-50/70 p-1 lg:hidden" role="tablist" aria-label="Step workspace">
          {(['input', 'configure', 'output'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={mobileWorkspaceTab === tab}
              onClick={() => setMobileWorkspaceTab(tab)}
              className={cn('rounded-md px-2 py-2 text-xs font-semibold capitalize', mobileWorkspaceTab === tab ? 'bg-white text-indigo-700 shadow-1' : 'text-muted-foreground')}
            >
              {tab}
            </button>
          ))}
        </div>
      )}

      <div className={cn('min-h-0 flex-1', isWorkspace && 'grid lg:grid-cols-[minmax(250px,0.8fr)_minmax(480px,1.25fr)_minmax(250px,0.8fr)]')}>
        {isWorkspace && (
          <aside className={cn('min-h-0 flex-col border-r border-border bg-slate-50/70', mobileWorkspaceTab === 'input' ? 'flex' : 'hidden', 'lg:flex')}>
            <div className="border-b border-border px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Database className="h-4 w-4 text-indigo-600" />
                  <p className="text-sm font-semibold">Input</p>
                </div>
                {/* Schema vs JSON. The configure column hides its inline data
                    picker at this width and hands the job to this pane, so
                    without a schema view the widest layout was the one with no
                    way to put upstream data into a field at all. */}
                <div className="flex rounded-md border border-border bg-white p-0.5" role="tablist" aria-label="Input view">
                  {(['schema', 'json'] as const).map((view) => (
                    <button
                      key={view}
                      type="button"
                      role="tab"
                      aria-selected={inputView === view}
                      onClick={() => setInputView(view)}
                      className={cn(
                        'rounded px-2 py-0.5 text-[11px] font-semibold capitalize transition-colors',
                        inputView === view ? 'bg-indigo-50 text-indigo-700' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {view}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {inputView === 'schema'
                  ? 'The data this step can read. Click a value to add it to the field you are editing.'
                  : 'Raw JSON this step received on the selected run — its resolved input, or the upstream data feeding it.'}
              </p>
            </div>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
              {rawInputInferred && rawInput !== undefined && inputView === 'json' && (
                <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  Inferred from upstream outputs — this step did not record an input on the selected run.
                </p>
              )}
              {inputView === 'schema' ? (
                <DataTree
                  fields={dataFields}
                  onInsert={insertToken}
                  title="Available data"
                  emptyMessage="No earlier step data is available yet — run the steps before this one to see what they produce."
                />
              ) : (
                rawInput === undefined ? (
                  <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-graphite-950 p-3 font-mono text-[11px] leading-5 text-graphite-100">
                    {'No input data yet.\nExecute the previous nodes to inspect their raw output here.'}
                  </pre>
                ) : (
                  <StructuredValueView value={rawInput} maxHeight="max-h-[28rem]" />
                )
              )}
              {!isTrigger && onExecutePrevious && rawInput === undefined && (
                <Button type="button" variant="outline" size="sm" className="w-full" onClick={onExecutePrevious}>
                  <Play className="mr-1.5 h-4 w-4" /> Execute previous nodes
                </Button>
              )}
            </div>
          </aside>
        )}

        <div className={cn('min-h-0 min-w-0 flex-col', !isWorkspace || mobileWorkspaceTab === 'configure' ? 'flex' : 'hidden', 'lg:flex')}>
          <div
            className={cn(
              'flex-1 space-y-5 overflow-y-auto',
              isWorkspace
                ? 'mx-auto w-full max-w-4xl p-6 md:p-8 md:[&_[data-flow-data-tree]]:hidden'
                : 'p-4',
            )}
          >
        {/* A disabled step keeps every setting below and runs none of them.
            Without saying so, the panel for a skipped step looks exactly like
            the panel for a live one — and now that the toggle lives here, that
            silence is right where someone would flip it. */}
        {node.disabled && (
          <PanelNotice tone="warning">
            This step is disabled — the flow skips it and carries on with the value from the step before it.
          </PanelNotice>
        )}
        {/* Only the findings no single control owns. Everything else is
            rendered at its field by <FieldIssues>, so "which box is wrong" is
            answered by looking at the box rather than by matching a sentence
            in a banner to one of a dozen inputs. */}
        {bannerIssues.length > 0 && (
          <div
            className={cn(
              'rounded-md border p-3 text-sm',
              bannerIssues.some((issue) => issue.level === 'error') ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50',
            )}
          >
            <p className="font-semibold text-slate-900">This step needs attention</p>
            <ul className="mt-2 space-y-1.5">
              {[...bannerIssues]
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
        {fieldIssues.size > 0 && bannerIssues.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {issueCount === 1 ? 'One field below needs attention.' : `${issueCount} fields below need attention.`}
          </p>
        )}
        {isTrigger && <FieldIssues issues={issueFor('trigger')} />}
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
            <FieldIssues issues={issueFor('inputFields')} />
          </TriggerEditor>
        ) : (
          <>
            {/* Step type selector removed — a node's type is fixed once added. */}
            {/* The name lives in the header now — one rename affordance, in the
                place n8n puts it, and HTTP steps get it too instead of being
                the one type you could not name from its own panel. Notes stay
                hidden for HTTP so its Parameters view stays lean. */}
            {node.type !== 'http' && (
              <>
                {typeof (node.data as { note?: string }).note === 'string' ? (
                  <div>
                    <label className={labelClass} htmlFor={`${uid}-step-note`}>Notes</label>
                    <textarea
                      id={`${uid}-step-note`}
                      rows={2}
                      className={fieldClass}
                      onKeyDown={indentOnTab}
                      value={(node.data as { note?: string }).note ?? ''}
                      placeholder="Why this step exists, gotchas, links…"
                      onFocus={blockActive}
                      onBlur={(e) => {
                        unblockActive()
                        // An emptied note disappears back to the "Add a note" link.
                        if (!e.target.value.trim()) onChange({ ...node, data: { ...node.data, note: undefined } } as FlowNode)
                      }}
                      onChange={(e) => onChange({ ...node, data: { ...node.data, note: e.target.value } } as FlowNode)}
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    className="self-start text-xs font-semibold text-primary hover:underline"
                    onClick={() => onChange({ ...node, data: { ...node.data, note: '' } } as FlowNode)}
                  >
                    + Add a note
                  </button>
                )}
              </>
            )}
            {/* Per-item fan-out used to render HERE, above Method and URL — the
                first control on every step, and an advanced one. n8n keeps this
                class of setting out of the parameter list entirely; ours now
                sits with the other run-behaviour settings at the bottom, so the
                panel opens on what the step actually does. */}
          </>
        )}

        {node.type === 'agent' && (
          <>
            <div>
              <label className={labelClass} htmlFor={`${uid}-agent`}>Agent</label>
              <select id={`${uid}-agent`} className={fieldClass} value={node.data.agentId} onChange={(e) => onChange({ ...node, data: { ...node.data, agentId: e.target.value } })}>
                <option value="">Select an agent…</option>
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.title}
                  </option>
                ))}
              </select>
              <FieldIssues issues={issueFor('agentId')} />
            </div>
            {!node.data.agentId && (
              <AgentInlineCreate
                onCreated={(agent) => {
                  onChange({ ...node, data: { ...node.data, agentId: agent.id } })
                  onRefreshAgents?.()
                }}
              />
            )}
            <div>
              <span className={labelClass}>Message to agent</span>
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
              <FieldIssues issues={issueFor('input')} />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-upstream`}>Data from earlier steps</label>
              <select
                id={`${uid}-upstream`}
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
            {/* Chat model, memory, and tool grants are n8n-style sub-nodes ON
                THE CANVAS, under the step — each opens its own config panel.
                Keeping them out of this drawer keeps agent + message the whole
                story here, and gives every attachment one obvious home. */}
            <p className="rounded-lg border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">
              Chat model, memory, and extra tools attach <span className="font-medium text-foreground">under this step on the canvas</span> — click an
              attachment there to configure it.
            </p>

            <div>
              <label className={labelClass} htmlFor={`${uid}-tool-policy`}>Tools this step may use</label>
              <select
                id={`${uid}-tool-policy`}
                className={fieldClass}
                value={node.data.toolPolicy?.mode ?? 'inherit'}
                onChange={(e) => {
                  const mode = e.target.value as 'inherit' | 'readonly' | 'none'
                  onChange({
                    ...node,
                    data: { ...node.data, toolPolicy: mode === 'inherit' ? undefined : { mode } },
                  })
                }}
              >
                <option value="inherit">Everything the agent has</option>
                <option value="readonly">Read-only — no sending, creating, or deleting</option>
                <option value="none">No tools — reasoning only</option>
              </select>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Read-only is the safe choice for steps that summarize or analyze: even if the content this
                step reads tries to steer the agent, there is nothing here that can send or change data.
              </p>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-human-assist`}>Human assistance</label>
              <select
                id={`${uid}-human-assist`}
                className={fieldClass}
                value={node.data.humanAssistance === false ? 'off' : 'on'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, humanAssistance: e.target.value === 'off' ? false : undefined } })}
              >
                <option value="on">Pause and ask when unsure</option>
                <option value="off">Never ask — fail instead</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-response-format`}>Agent response</label>
              <select
                id={`${uid}-response-format`}
                className={fieldClass}
                value={node.data.responseFormat ?? 'text'}
                onChange={(e) => onChange({ ...node, data: { ...node.data, responseFormat: e.target.value === 'structured' ? 'structured' : undefined } })}
              >
                <option value="text">Text only</option>
                <option value="structured">Structured (JSON matching output fields)</option>
              </select>
              {node.data.responseFormat === 'structured' && !(node.data.outputFields ?? []).some((f) => f.name.trim()) && (
                <PanelNotice tone="warning" className="mt-1.5">Add at least one output field below to define the JSON shape.</PanelNotice>
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
              <label className={labelClass} htmlFor={`${uid}-ai-op`}>Operation</label>
              <select id={`${uid}-ai-op`} className={fieldClass} value={node.data.aiOp} onChange={(e) => onChange({ ...node, data: { ...node.data, aiOp: e.target.value as AiOp } })}>
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
              <span className={labelClass}>Input</span>
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
              <FieldIssues issues={issueFor('aiInput')} />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-ai-model`}>Model</label>
              <select
                id={`${uid}-ai-model`}
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
                <span className={labelClass}>Categories</span>
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
                  <label className={labelClass} htmlFor={`${uid}-score-min`}>Lowest score</label>
                  <input
                    id={`${uid}-score-min`}
                    type="number"
                    className={fieldClass}
                    value={node.data.scoreMin ?? 1}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, scoreMin: Number(e.target.value) } })}
                    aria-label="Lowest score"
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor={`${uid}-score-max`}>Highest score</label>
                  <input
                    id={`${uid}-score-max`}
                    type="number"
                    className={fieldClass}
                    value={node.data.scoreMax ?? 10}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, scoreMax: Number(e.target.value) } })}
                    aria-label="Highest score"
                  />
                </div>
              </div>
            )}

          </>
        )}

        {node.type === 'knowledge' && (
          <>
            <div>
              <span className={labelClass}>What to look for</span>
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
              <FieldIssues issues={issueFor('query')} />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-topk`}>How many passages</label>
              <input
                id={`${uid}-topk`}
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
          <SubflowDrawerSection node={node} onChange={onChange} flowId={flowId} labelCtx={labelCtx} registerEditor={registerEditor} focusEditor={focusEditor} dataFields={dataFields} insertToken={insertToken} issueFor={issueFor} />
        )}

        {node.type === 'condition' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass} htmlFor={`${uid}-cond-match`}>Conditions</label>
              <select
                id={`${uid}-cond-match`}
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
                      {operatorsForField(clause.left, dataFields, clause.op).map((op) => (
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
                      <button type="button" onClick={() => update(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove Condition">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                  {/* n8n exposes Ignore Case on If, Filter AND Switch. Our
                      schema and evaluator have honoured it on all three since
                      it was added; only the Filter panel ever offered the
                      control, so on the other two it was a stored, working
                      setting nobody could reach. */}
                  {!UNARY_CONDITION_OPS.has(clause.op) && (
                    <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={clause.ignoreCase === true}
                        onChange={(e) => update(clauses.map((c, j) => (j === i ? { ...c, ignoreCase: e.target.checked || undefined } : c)))}
                      />
                      Ignore upper/lower case
                    </label>
                  )}
                </div>
              )
            })}
            <button
              type="button"
              onClick={() => onChange({ ...node, data: { ...node.data, clauses: [...clausesOf(node.data), { left: '', op: 'contains', right: '' }], left: undefined, op: undefined, right: undefined } })}
              className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              <Plus className="h-3.5 w-3.5" /> Add Condition
            </button>
            <FieldIssues issues={issueFor('clauses')} />
            <div>
              <DataTree fields={dataFields} onInsert={insertToken} />
            </div>
          </div>
        )}

        {node.type === 'loop' && (
          <div className="space-y-3">
            <div>
              <span className={labelClass}>Items to process</span>
              <TokenTextEditor
                ref={registerEditor('loop.over')}
                value={node.data.over}
                labelCtx={labelCtx}
                placeholder="Choose a list from the available data below"
                onFocus={focusEditor('loop.over')}
                onChange={(over) => onChange({ ...node, data: { ...node.data, over } })}
                ariaLabel="Items to process"
              />
              <FieldIssues issues={issueFor('loopSource')} />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">Accepts a JSON list, a newline list, or a comma-separated list. Nested steps run once for each item.</p>
            </div>
            {/* "At a time" is an option now — a loop runs one at a time until
                someone says otherwise, and the control was on the page whether
                or not anyone wanted it. It reads its stored value unchanged. */}
            <div>
              <label className={labelClass} htmlFor={`${uid}-loop-item-error`}>If an item fails</label>
              <select
                id={`${uid}-loop-item-error`}
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
            issueFor={issueFor}
            onChange={onChange}
          />
        )}

        {node.type === 'http' && (
          <div className="space-y-5">
            {/* This step is really an MCP call, hand-built. Calling an MCP
                server over HTTP means a POST carrying a JSON-RPC envelope, with
                the tool name buried in a body field and the arguments written
                as JSON by hand. The Tool step is the same call as three
                controls, with the action picked from a list and the arguments
                rendered from the tool's own schema. */}
            {mcpSuggestion && (
              <PanelNotice
                action={
                  <Button
                  type="button"
                  size="sm"
                  onClick={() => onChange({
                    id: node.id,
                    type: 'tool',
                    position: (node as { position?: unknown }).position,
                    ...(node.disabled ? { disabled: true } : {}),
                    data: {
                      ...(node.data.label ? { label: node.data.label } : {}),
                      connectionId: mcpSuggestion.connectionId,
                      toolName: mcpSuggestion.toolName ?? '',
                      args: mcpSuggestion.args ?? '{}',
                    },
                  } as unknown as FlowNode)}
                >
                  Use a Tool step instead
                  </Button>
                }
              >
                <span className="font-medium">This calls {mcpSuggestion.connectionName} over MCP.</span>{' '}
                A Tool step makes the same call without the JSON-RPC envelope — pick the action from a
                list, and its arguments come from the tool&apos;s own schema.
              </PanelNotice>
            )}
            <div className="flex justify-end">
              <Button type="button" variant="outline" size="sm" onClick={() => setCurlDialogOpen(true)}>
                <TerminalSquare className="mr-1.5 h-4 w-4" /> Import cURL
              </Button>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-http-method`}>Method</label>
              <select
                id={`${uid}-http-method`}
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
              <label className={labelClass} htmlFor={`${uid}-http-url`}>URL</label>
              <input
                id={`${uid}-http-url`}
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
              <FieldIssues issues={issueFor('url')} />
            </div>

            <div>
              <label className={labelClass} htmlFor={`${uid}-http-auth`}>Authentication</label>
              <select
                id={`${uid}-http-auth`}
                className={fieldClass}
                value={httpAuthMode}
                onChange={(event) => {
                  const mode = event.target.value as 'predefined' | 'generic'
                  setHttpAuthMode(mode)
                  if (mode !== 'predefined' && node.data.connectionId) onChange({ ...node, data: { ...node.data, connectionId: undefined } })
                  if (mode !== 'generic' && node.data.credentialId) onChange({ ...node, data: { ...node.data, credentialId: undefined } })
                }}
              >
                <option value="predefined">Connected server (MCP)</option>
                <option value="generic">Manual credential</option>
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                {httpAuthMode === 'predefined'
                  ? 'Reuse a connected MCP server’s token for authentication.'
                  : 'Choose an auth method, then set up a reusable credential for this host.'}
              </p>
              {/* The checker owns this message now — it knows which brand the
                  URL points at and whether that integration is connected, so
                  it says something more useful than a generic warning could. */}
              <FieldIssues issues={issueFor('httpAuth')} />
            </div>

            {httpAuthMode === 'predefined' && (
              <div>
                <label className={labelClass} htmlFor={`${uid}-http-connection`}>Connected server</label>
                {predefinedConnections.length === 0 ? (
                  <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                    No MCP servers with an injectable token are connected. App integrations (Slack, Salesforce, …)
                    authenticate through Tool steps instead — for a raw HTTP call, add an MCP server under
                    Integrations → MCP Servers, or use a manual credential.
                  </p>
                ) : (
                  <select
                    id={`${uid}-http-connection`}
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
                <label className={labelClass} htmlFor={`${uid}-http-auth-type`}>Generic Auth Type</label>
                <select
                  id={`${uid}-http-auth-type`}
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
                <label className={labelClass} htmlFor={`${uid}-http-credential`}>Credential</label>
                <div className="flex gap-2">
                  <select
                    id={`${uid}-http-credential`}
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
                  <p className="text-sm font-medium">Send Query Parameters</p>
                  <p className="text-xs text-muted-foreground">Add JSON key/value parameters to the URL.</p>
                </div>
                <Switch
                  checked={node.data.sendQuery ?? Boolean(node.data.query?.trim())}
                  onCheckedChange={(sendQuery) => onChange({ ...node, data: { ...node.data, sendQuery } })}
                  aria-label="Send Query Parameters"
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
                  <p className="text-sm font-medium">Send Headers</p>
                  <p className="text-xs text-muted-foreground">Add non-secret request headers as JSON.</p>
                </div>
                <Switch
                  checked={node.data.sendHeaders ?? Boolean(node.data.headers?.trim())}
                  onCheckedChange={(sendHeaders) => onChange({ ...node, data: { ...node.data, sendHeaders } })}
                  aria-label="Send Headers"
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
                  <p className="text-sm font-medium">Send Body</p>
                  <p className="text-xs text-muted-foreground">Configure the request payload.</p>
                </div>
                <Switch
                  checked={node.data.sendBody ?? Boolean(node.data.body?.trim())}
                  disabled={node.data.method === 'GET' || node.data.method === 'HEAD'}
                  onCheckedChange={(sendBody) => onChange({ ...node, data: { ...node.data, sendBody } })}
                  aria-label="Send Body"
                />
              </div>
              {(node.data.method === 'GET' || node.data.method === 'HEAD') && (
                <p className="text-xs text-amber-700">HTTP {node.data.method} requests do not send a body.</p>
              )}
              {(node.data.sendBody ?? Boolean(node.data.body?.trim())) && node.data.method !== 'GET' && node.data.method !== 'HEAD' && (
                <>
                  <div>
                    <label className={labelClass} htmlFor={`${uid}-http-body-mode`}>Body Content Type</label>
                    <select
                      id={`${uid}-http-body-mode`}
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
                    <>
                    <KeyValueJsonEditor
                      label="Body fields"
                      value={node.data.body}
                      keyPlaceholder="field"
                      valuePlaceholder="Value or input data"
                      helper={node.data.bodyMode === 'form-data'
                        ? 'These fields are sent as multipart/form-data text parts. Attach files below.'
                        : 'These JSON fields are encoded as application/x-www-form-urlencoded.'}
                      onChange={(body) => onChange({ ...node, data: { ...node.data, body } })}
                      labelCtx={labelCtx}
                      editorKey="http.body"
                      registerEditor={registerEditor}
                      focusEditor={focusEditor}
                      blockActive={blockActive}
                      unblockActive={unblockActive}
                    />
                    {node.data.bodyMode === 'form-data' && (
                      <FormFileFields
                        bindings={node.data.formFiles ?? []}
                        options={fileOptions}
                        onChange={(formFiles) => onChange({ ...node, data: { ...node.data, formFiles } })}
                      />
                    )}
                    </>
                  ) : (
                    <div>
                      {(node.data.bodyMode === 'raw' || node.data.bodyMode === 'text') && (
                        <div className="mb-3">
                          <label className={labelClass} htmlFor={`${uid}-http-content-type`}>Content type</label>
                          <input
                            id={`${uid}-http-content-type`}
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

            {/* One Options control, holding everything optional. It replaced
                two differently-named <details> and a separate "Advanced
                parameters" panel: a step with a quarter of n8n's configuration
                read as the busier one because its optional settings were behind
                four lids of three different shapes. The nested editors below are
                unchanged — the collection only decides whether they exist. */}
            <NodeOptions
              node={node}
              onChange={onChange}
              renderCustom={(option: NodeOption) => {
                if (option.key === 'pagination') {
                  return (
                    <div className="space-y-3">
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
                    </div>
                  )
                }
                if (option.key === 'optimizeForAi') {
                  return (
                    <div className="grid grid-cols-2 gap-2">
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="col-span-2 text-xs">Keep only this part (path)<input className={fieldClass} placeholder="data" value={node.data.optimizeForAi?.dataPath ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, optimizeForAi: cleanOptimize({ ...node.data.optimizeForAi, dataPath: e.target.value || undefined }) } })} /></label>
                <label className="col-span-2 text-xs">Keep only these fields (comma-separated)<input className={fieldClass} placeholder="id, name, email" value={(node.data.optimizeForAi?.fields ?? []).join(', ')} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, optimizeForAi: cleanOptimize({ ...node.data.optimizeForAi, fields: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }) } })} /></label>
                <label className="text-xs">Max items<input type="number" min={1} className={fieldClass} placeholder="No limit" value={node.data.optimizeForAi?.maxItems ?? ''} onFocus={blockActive} onBlur={unblockActive} onChange={(e) => onChange({ ...node, data: { ...node.data, optimizeForAi: cleanOptimize({ ...node.data.optimizeForAi, maxItems: e.target.value === '' ? undefined : Math.max(1, Number(e.target.value)) }) } })} /></label>
              </div>
                    </div>
                  )
                }
                if (option.key === 'perItem') {
                  return (
                    <PerItemSection
                      node={node}
                      onChange={onChange}
                      dataFields={dataFields}
                      labelCtx={labelCtx}
                      registerEditor={registerEditor}
                      focusEditor={focusEditor}
                      insertToken={insertToken}
                    />
                  )
                }
                return null
              }}
            />

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
              <Plus className="h-3.5 w-3.5" /> Add Field
            </button>
            <FieldIssues issues={issueFor('fields')} />
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={node.data.includeOtherFields === true}
                onChange={(e) => onChange({ ...node, data: { ...node.data, includeOtherFields: e.target.checked || undefined } })}
              />
              Include Other Input Fields
            </label>
            {/* WHICH ones, not just whether. All-or-nothing forces a choice
                between dragging an entire upstream record downstream or
                re-mapping every field you wanted to keep. */}
            {node.data.includeOtherFields === true && (
              <div>
                <label className={labelClass} htmlFor={`${uid}-set-include-mode`}>Include in Output</label>
                <select
                  id={`${uid}-set-include-mode`}
                  className={fieldClass}
                  value={node.data.includeMode ?? 'all'}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, includeMode: e.target.value === 'all' ? undefined : (e.target.value as 'selected' | 'except') } })}
                >
                  <option value="all">All Input Fields</option>
                  <option value="selected">Selected Input Fields</option>
                  <option value="except">All Input Fields Except</option>
                </select>
                {node.data.includeMode !== undefined && node.data.includeMode !== 'all' && (
                  <input
                    className={`${fieldClass} mt-1.5`}
                    value={(node.data.includeFields ?? []).join(', ')}
                    placeholder="id, name, owner"
                    aria-label={node.data.includeMode === 'selected' ? 'Fields to Include' : 'Fields to Exclude'}
                    onFocus={blockActive}
                    onBlur={unblockActive}
                    onChange={(e) => onChange({
                      ...node,
                      data: {
                        ...node.data,
                        includeFields: e.target.value.split(',').map((field) => field.trim()).filter(Boolean),
                      },
                    })}
                  />
                )}
              </div>
            )}
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
                      {operatorsForField(clause.left, dataFields, clause.op).map((op) => <option key={op} value={op}>{CONDITION_OP_LABELS[op]}</option>)}
                    </select>
                    {!UNARY_CONDITION_OPS.has(clause.op) && (
                      <TokenTextEditor ref={registerEditor(`filt.${i}.right`)} className="min-w-0 flex-1 px-2 py-1.5" value={clause.right} labelCtx={labelCtx} placeholder="80" onFocus={focusEditor(`filt.${i}.right`)} onChange={(right) => update(clauses.map((c, j) => (j === i ? { ...c, right } : c)))} ariaLabel={`Filter ${i + 1} comparison value`} />
                    )}
                    {clauses.length > 1 && (
                      <button type="button" onClick={() => update(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove Condition"><Trash2 className="h-4 w-4" /></button>
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
              <Plus className="h-3.5 w-3.5" /> Add Condition
            </button>
            <FieldIssues issues={issueFor('clauses')} />
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
                    <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, cases: node.data.cases.filter((_, j) => j !== i) } })} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove Routing Rule"><Trash2 className="h-4 w-4" /></button>
                  )}
                </div>
                <TokenTextEditor ref={registerEditor(`sw.${i}.left`)} className="px-2 py-1.5" value={c.left} labelCtx={labelCtx} placeholder="Choose data from below" onFocus={focusEditor(`sw.${i}.left`)} onChange={(left) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, left } : x)) } })} ariaLabel={`Case ${i + 1} value`} />
                <div className="flex gap-1.5">
                  <select className={smallField} value={c.op} onChange={(e) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, op: e.target.value as ConditionOp } : x)) } })}>
                    {operatorsForField(c.left, dataFields, c.op).map((op) => <option key={op} value={op}>{CONDITION_OP_LABELS[op]}</option>)}
                  </select>
                  <TokenTextEditor ref={registerEditor(`sw.${i}.right`)} className="min-w-0 flex-1 px-2 py-1.5" value={c.right} labelCtx={labelCtx} placeholder="enterprise" onFocus={focusEditor(`sw.${i}.right`)} onChange={(right) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, right } : x)) } })} ariaLabel={`Case ${i + 1} comparison value`} />
                </div>
                {!UNARY_CONDITION_OPS.has(c.op) && (
                  <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={c.ignoreCase === true}
                      onChange={(e) => onChange({ ...node, data: { ...node.data, cases: node.data.cases.map((x, j) => (j === i ? { ...x, ignoreCase: e.target.checked || undefined } : x)) } })}
                    />
                    Ignore upper/lower case
                  </label>
                )}
              </div>
            ))}
            <button type="button" onClick={() => onChange({ ...node, data: { ...node.data, cases: [...node.data.cases, { id: `case${node.data.cases.length + 1}-${Math.random().toString(36).slice(2, 6)}`, left: '', op: 'contains', right: '' }] } })} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700">
              <Plus className="h-3.5 w-3.5" /> Add Routing Rule
            </button>
            <FieldIssues issues={issueFor('cases')} />
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={node.data.allMatches === true}
                onChange={(e) => onChange({ ...node, data: { ...node.data, allMatches: e.target.checked || undefined } })}
              />
              Send data to all matching outputs
            </label>
            <div><DataTree fields={dataFields} onInsert={insertToken} /></div>
          </div>
        )}

        {node.type === 'stop' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass} htmlFor={`${uid}-stop-error-type`}>Error Type</label>
              <select
                id={`${uid}-stop-error-type`}
                className={fieldClass}
                value={node.data.errorType ?? 'none'}
                onChange={(e) => {
                  const value = e.target.value
                  onChange({
                    ...node,
                    data: {
                      ...node.data,
                      errorType: value === 'none' ? undefined : (value as 'errorMessage' | 'errorObject'),
                    },
                  })
                }}
              >
                {/* Ours has a third state n8n does not: end the run without
                    failing it. It is what every flow saved before this does, so
                    it stays the default — "we are done here" and "this is
                    wrong" are different endings and both are worth having. */}
                <option value="none">Stop without an error</option>
                <option value="errorMessage">Error Message</option>
                <option value="errorObject">Error Object</option>
              </select>
            </div>

            {node.data.errorType === undefined && (
              <div>
                <label className={labelClass} htmlFor={`${uid}-stop-reason`}>Reason</label>
                <input
                  id={`${uid}-stop-reason`}
                  className={fieldClass}
                  value={node.data.reason ?? ''}
                  placeholder="Why the flow stops here"
                  onChange={(e) => onChange({ ...node, data: { ...node.data, reason: e.target.value } })}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">Ends the flow early; later steps are skipped and the run is not a failure.</p>
              </div>
            )}

            {node.data.errorType === 'errorMessage' && (
              <div>
                <label className={labelClass} htmlFor={`${uid}-stop-error-message`}>Error Message</label>
                <input
                  id={`${uid}-stop-error-message`}
                  className={fieldClass}
                  value={node.data.errorMessage ?? ''}
                  placeholder="An error occurred!"
                  onChange={(e) => onChange({ ...node, data: { ...node.data, errorMessage: e.target.value } })}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">The run fails here, and this is what it reports.</p>
              </div>
            )}

            {node.data.errorType === 'errorObject' && (
              <div>
                <label className={labelClass} htmlFor={`${uid}-stop-error-object`}>Error Object</label>
                <textarea
                  id={`${uid}-stop-error-object`}
                  rows={4}
                  className={areaClass}
                  onKeyDown={indentOnTab}
                  value={node.data.errorObject ?? ''}
                  placeholder={'{ "message": "Quota exceeded", "code": 429 }'}
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, errorObject: e.target.value } })}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">The run fails here. A <code>message</code> inside the object is what it reports; the whole object travels with it.</p>
              </div>
            )}
          </div>
        )}

        {node.type === 'variable' && (
          <VariableEditor
            node={node}
            variableNames={variableNames ?? []}
            issueFor={issueFor}
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
            issueFor={issueFor}
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
              <span className={labelClass}>Message</span>
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
              <FieldIssues issues={issueFor('reviewMessage')} />
              <div className="mt-2">
                <DataTree fields={dataFields} onInsert={insertToken} />
              </div>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-hr-assignee`}>Assign to (optional)</label>
              {/* Empty value = engine default (the run owner is asked). A stored
                  assignee missing from the roster (departed member) stays selected
                  as "Former member" so opening the editor never rewrites data. */}
              <select
                id={`${uid}-hr-assignee`}
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
            issueFor={issueFor}
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
              <label className={labelClass} htmlFor={`${uid}-code-mode`}>Mode</label>
              <select id={`${uid}-code-mode`} className={fieldClass} value={node.data.mode} onChange={(e) => onChange({ ...node, data: { ...node.data, mode: e.target.value === 'each' ? 'each' : 'all' } })}>
                <option value="all">Run once for all input</option>
                <option value="each">Run once for each item</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-code-language`}>Language</label>
              <select
                id={`${uid}-code-language`}
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
              <span className={labelClass}>Input</span>
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
              <FieldIssues issues={issueFor('code')} />
            </div>

          </>
        )}

        {node.type === 'note' && (
          <div className="space-y-3">
            <div>
              <label className={labelClass} htmlFor={`${uid}-note-text`}>Note</label>
              <textarea
                id={`${uid}-note-text`}
                rows={6}
                className={areaClass}
                onKeyDown={indentOnTab}
                value={node.data.text}
                placeholder="Document this part of the flow — what it does, gotchas, links…"
                onFocus={blockActive}
                onBlur={unblockActive}
                onChange={(e) => onChange({ ...node, data: { ...node.data, text: e.target.value } })}
              />
            </div>
            <div>
              <label className={labelClass} htmlFor={`${uid}-note-color`}>Color</label>
              <select id={`${uid}-note-color`} className={fieldClass} value={node.data.color ?? 'yellow'} onChange={(e) => onChange({ ...node, data: { ...node.data, color: e.target.value as 'yellow' | 'blue' | 'green' | 'pink' } })}>
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
              <label className={labelClass} htmlFor={`${uid}-wait-mode`}>Wait for</label>
              <select
                id={`${uid}-wait-mode`}
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
                  <span className={labelClass}>Amount</span>
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
                  <label className={labelClass} htmlFor={`${uid}-wait-unit`}>Unit</label>
                  <select
                    id={`${uid}-wait-unit`}
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
                <span className={labelClass}>Wait until</span>
                <TokenTextEditor
                  ref={registerEditor('wait.until')}
                  value={node.data.until ?? ''}
                  labelCtx={labelCtx}
                  placeholder="e.g. 2026-08-01T09:00:00Z or pick a date value below"
                  onFocus={focusEditor('wait.until')}
                  onChange={(until) => onChange({ ...node, data: { ...node.data, until } })}
                  ariaLabel="Wait until"
                />
                <FieldIssues issues={issueFor('wait')} />
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
                  <label className={labelClass} htmlFor={`${uid}-wait-timeout`}>Give up after (minutes, optional)</label>
                  <input
                    id={`${uid}-wait-timeout`}
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
              <label className={labelClass} htmlFor={`${uid}-join-mode`}>Mode</label>
              <select
                id={`${uid}-join-mode`}
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
                Include Any Unpaired Items
              </label>
            )}
            {node.data.mode === 'combineByKey' && (
              <div>
                <label className={labelClass} htmlFor={`${uid}-join-key`}>Matching field</label>
                <input
                  id={`${uid}-join-key`}
                  className={fieldClass}
                  value={node.data.key ?? ''}
                  placeholder="e.g. email"
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, key: e.target.value || undefined } })}
                />
                <p className="mt-1.5 text-xs text-muted-foreground">Records from each branch that share this field are merged into one.</p>
                <label className="mt-2 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={node.data.keyRight !== undefined}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, keyRight: e.target.checked ? (node.data.key ?? '') : undefined } })}
                  />
                  Fields To Match Have Different Names
                </label>
                {node.data.keyRight !== undefined && (
                  <input
                    className={`${fieldClass} mt-1.5`}
                    value={node.data.keyRight}
                    placeholder="The field name on the other branch, e.g. emailAddress"
                    aria-label="Input 2 Field"
                    onFocus={blockActive}
                    onBlur={unblockActive}
                    onChange={(e) => onChange({ ...node, data: { ...node.data, keyRight: e.target.value } })}
                  />
                )}
              </div>
            )}
            {node.data.mode === 'combineByKey' && (
              <div>
                <label className={labelClass} htmlFor={`${uid}-join-output-type`}>Output Type</label>
                <select
                  id={`${uid}-join-output-type`}
                  className={fieldClass}
                  value={node.data.joinMode ?? (node.data.includeUnpaired === false ? 'keepMatches' : 'keepEverything')}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, joinMode: e.target.value as 'keepMatches' | 'keepNonMatches' | 'keepEverything' | 'enrichInput1' | 'enrichInput2' } })}
                >
                  <option value="keepMatches">Keep Matches</option>
                  <option value="keepNonMatches">Keep Non-Matches</option>
                  <option value="keepEverything">Keep Everything</option>
                  <option value="enrichInput1">Enrich Input 1</option>
                  <option value="enrichInput2">Enrich Input 2</option>
                </select>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Enrich Input 1 keeps every record of the first branch and adds the second&apos;s where they match.
                  Keep Non-Matches answers the opposite question — what found no partner.
                </p>
              </div>
            )}
            {node.data.mode === 'combineByKey' && (
              <div>
                <label className={labelClass} htmlFor={`${uid}-join-clash`}>Clash Handling</label>
                <select
                  id={`${uid}-join-clash`}
                  className={fieldClass}
                  value={node.data.clash ?? 'preferLast'}
                  onChange={(e) => onChange({ ...node, data: { ...node.data, clash: e.target.value as 'preferLast' | 'preferFirst' | 'deepMerge' } })}
                >
                  <option value="preferLast">Prefer the later branch</option>
                  <option value="preferFirst">Prefer the first branch</option>
                  <option value="deepMerge">Merge nested objects together</option>
                </select>
                <p className="mt-1.5 text-xs text-muted-foreground">Which value wins when both branches carry the same field.</p>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Point the ends of different branches at this step so the steps after it run once. In &quot;merge paths&quot; mode only the branch that ran continues; the combine modes gather every branch that produced data.
            </p>
          </div>
        )}
            {/* ONE Options collection, at the end of every step's parameters,
                where n8n puts it. Per-item, retries, timeout, on-error and the
                rest are options now — added when you want them, absent when you
                do not — replacing an "Advanced parameters" panel per node type
                and a per-item section that opened above the step's own fields.

                The HTTP step renders its own collection higher up, because it
                is the only type with nested editors (pagination, response
                trimming) that the collection has to show and hide. */}
            {!isTrigger && node.type !== 'http' && (
              <NodeOptions
                node={node}
                onChange={onChange}
                renderCustom={(option: NodeOption) =>
                  option.key === 'perItem' ? (
                    <PerItemSection
                      node={node}
                      onChange={onChange}
                      dataFields={dataFields}
                      labelCtx={labelCtx}
                      registerEditor={registerEditor}
                      focusEditor={focusEditor}
                      insertToken={insertToken}
                    />
                  ) : null
                }
              />
            )}
          </div>

          {!isTrigger && (
            <div className={cn('flex gap-2 border-t border-border', isWorkspace ? 'justify-end bg-slate-50/70 px-6 py-3' : 'p-4')}>
              {/* Disabling is how you take a step out of the run without
                  losing its configuration — it belonged next to Delete, not
                  only in the canvas card's overflow menu. */}
              {node.type !== 'condition' && node.type !== 'switch' && (
                <Button
                  variant="outline"
                  className={cn(isWorkspace ? 'mr-auto' : 'flex-1', node.disabled && 'border-amber-300 text-amber-700')}
                  onClick={() => onChange({ ...node, disabled: node.disabled ? undefined : true } as FlowNode)}
                >
                  {node.disabled ? <ToggleRight className="mr-1.5 h-4 w-4" /> : <ToggleLeft className="mr-1.5 h-4 w-4" />}
                  {node.disabled ? 'Enable step' : 'Disable step'}
                </Button>
              )}
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
          <aside className={cn('min-h-0 flex-col border-l border-border bg-slate-50/70', mobileWorkspaceTab === 'output' ? 'flex' : 'hidden', 'lg:flex')}>
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
                    className="min-h-40 w-full resize-y rounded-lg border border-amber-500/40 bg-graphite-950 p-3 font-mono text-[11px] leading-5 text-graphite-100 outline-none focus:border-amber-400 focus:ring-1 focus:ring-amber-400/50"
                    value={mockDraft}
                    spellCheck={false}
                    onKeyDown={indentOnTab}
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
                  {/* The same viewer the Runs panel uses: table view for a list
                      of records, search, and a row count. This pane rendered a
                      raw <pre>, so the one place you inspect a step's output
                      while configuring it was the one place you could not read
                      a 200-row response. */}
                  {rawOutput === undefined ? (
                    <pre className="min-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-graphite-950 p-3 font-mono text-[11px] leading-5 text-graphite-100">
                      {'No output data yet.\nExecute this step to inspect its response here.'}
                    </pre>
                  ) : (
                    <StructuredValueView value={rawOutput} maxHeight="max-h-[28rem]" />
                  )}
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
  issueFor,
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
  issueFor: (field: string) => FieldIssue[] | undefined
  onChange: (node: FlowNode) => void
} & TokenEditorPlumbing) {
  const uid = useId()
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
        <label className={labelClass} htmlFor={`${uid}-var-op`}>Operation</label>
        <select id={`${uid}-var-op`} className={fieldClass} value={node.data.op} onChange={(e) => setOp(e.target.value as VariableOp)}>
          {VARIABLE_OPS.map((op) => (
            <option key={op} value={op}>
              {VARIABLE_OP_LABELS[op]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelClass} htmlFor={`${uid}-var-name`}>Name</label>
        {isInitialize || nameOptions.length === 0 ? (
          <input
            id={`${uid}-var-name`}
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
            id={`${uid}-var-name`}
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
        <FieldIssues issues={issueFor('variableName')} />
      </div>
      {isInitialize && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-var-type`}>Type</label>
          <select
            id={`${uid}-var-type`}
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
        <FieldIssues issues={issueFor('variableValue')} />
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
  issueFor,
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
  issueFor: (field: string) => FieldIssue[] | undefined
  onChange: (node: FlowNode) => void
} & TokenEditorPlumbing) {
  const uid = useId()
  const op = node.data.op
  const clauses = node.data.clauses?.length ? node.data.clauses : [{ left: '', op: 'contains' as ConditionOp, right: '' }]
  const fields = node.data.fields?.length ? node.data.fields : [{ name: '', value: '' }]
  const setOp = (next: DataOp) => {
    // Ops with required list config start with one empty row so the editor
    // opens ready to fill in.
    const nextClauses = next === 'filterArray' && !(node.data.clauses ?? []).length ? [{ left: '', op: 'contains' as ConditionOp, right: '' }] : node.data.clauses
    const nextFields = (next === 'select' || next === 'compose' || next === 'renameKeys') && !(node.data.fields ?? []).length ? [{ name: '', value: '' }] : node.data.fields
    onChange({ ...node, data: { ...node.data, op: next, clauses: nextClauses, fields: nextFields } })
  }
  const setClauses = (next: ConditionClause[]) => onChange({ ...node, data: { ...node.data, clauses: next } })
  const setFields = (next: { name: string; value: string }[]) => onChange({ ...node, data: { ...node.data, fields: next } })
  return (
    <div className="space-y-3">
      <div>
        <label className={labelClass} htmlFor={`${uid}-data-op`}>Operation</label>
        <select id={`${uid}-data-op`} className={fieldClass} value={op} onChange={(e) => setOp(e.target.value as DataOp)}>
          {DATA_OPS.map((entry) => (
            <option key={entry} value={entry}>
              {DATA_OP_LABELS[entry]}
            </option>
          ))}
        </select>
      </div>
      <div>
        <span className={labelClass}>Input</span>
        <TokenTextEditor
          ref={registerEditor('data.input')}
          value={node.data.input ?? ''}
          labelCtx={labelCtx}
          placeholder={DATA_OP_INPUT_PLACEHOLDER[op]}
          onFocus={focusEditor('data.input')}
          onChange={(input) => onChange({ ...node, data: { ...node.data, input } })}
          ariaLabel="Input"
        />
        <FieldIssues issues={issueFor('dataInput')} />
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
            <label className={labelClass} htmlFor={`${uid}-data-find`}>Find</label>
            <input
              id={`${uid}-data-find`}
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
            <label className={labelClass} htmlFor={`${uid}-data-replace`}>Replace with</label>
            <input
              id={`${uid}-data-replace`}
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
          <label className={labelClass} htmlFor={`${uid}-data-index`}>Position</label>
          <input
            id={`${uid}-data-index`}
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
            <label className={labelClass} htmlFor={`${uid}-trim-count`}>Items to remove</label>
            <input
              id={`${uid}-trim-count`}
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
            <label className={labelClass} htmlFor={`${uid}-trim-from`}>From</label>
            <select
              id={`${uid}-trim-from`}
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
          <label className={labelClass} htmlFor={`${uid}-data-schema`}>Schema (optional)</label>
          <textarea
            id={`${uid}-data-schema`}
            rows={4}
            className={`${areaClass} font-mono text-xs`}
            onKeyDown={indentOnTab}
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
          <div>
            <label className={labelClass} htmlFor={`${uid}-filter-match`}>Keep items where</label>
            <select
              id={`${uid}-filter-match`}
              className={fieldClass}
              value={node.data.match === 'any' ? 'any' : 'all'}
              onChange={(e) => onChange({ ...node, data: { ...node.data, match: e.target.value === 'any' ? 'any' : undefined } })}
              aria-label="How conditions combine"
            >
              <option value="all">Every condition passes</option>
              <option value="any">Any condition passes</option>
            </select>
          </div>
          <span className={labelClass}>Conditions</span>
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
                  {operatorsForField(clause.left, dataFields, clause.op).map((entry) => (
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
                  <button type="button" onClick={() => setClauses(clauses.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label="Remove Condition">
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
            <Plus className="h-3.5 w-3.5" /> Add Condition
          </button>
          <FieldIssues issues={issueFor('clauses')} />
          <p className="text-[11px] text-muted-foreground">Each condition checks one item of the list at a time.</p>
        </div>
      )}
      {(op === 'sort' || op === 'removeDuplicates' || op === 'summarize') && (
        <div>
          <label className={labelClass}>{op === 'summarize' ? 'Group by field(s)' : 'Field(s)'}</label>
          <input
            className={fieldClass}
            value={node.data.by ?? ''}
            placeholder={op === 'summarize' ? 'Leave empty to summarize the whole list — several fields separate with commas' : 'Leave empty to use the whole item — several fields separate with commas'}
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, by: e.target.value } })}
          />
        </div>
      )}
      {op === 'flatten' && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-flatten-by`}>Field holding the list (optional)</label>
          <input
            id={`${uid}-flatten-by`}
            className={fieldClass}
            value={node.data.by ?? ''}
            placeholder="Leave empty to unnest lists inside lists"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, by: e.target.value || undefined } })}
          />
          <p className="mt-1 text-[11px] text-muted-foreground">With a field, each of its entries becomes its own item, carrying the record&apos;s other fields along.</p>
        </div>
      )}
      {op === 'formatDate' && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-date-format`}>Pattern</label>
          <input
            id={`${uid}-date-format`}
            className={fieldClass}
            value={node.data.format ?? ''}
            placeholder="YYYY-MM-DD — tokens: YYYY, MM, DD, HH, mm, ss"
            onFocus={blockActive}
            onBlur={unblockActive}
            onChange={(e) => onChange({ ...node, data: { ...node.data, format: e.target.value || undefined } })}
            aria-label="Date pattern"
          />
        </div>
      )}
      {op === 'dateShift' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelClass} htmlFor={`${uid}-shift-amount`}>Amount</label>
            <input
              id={`${uid}-shift-amount`}
              className={fieldClass}
              value={node.data.amount ?? ''}
              placeholder="3 — negative subtracts"
              onFocus={blockActive}
              onBlur={unblockActive}
              onChange={(e) => onChange({ ...node, data: { ...node.data, amount: e.target.value || undefined } })}
              aria-label="Amount"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${uid}-shift-unit`}>Unit</label>
            <select
              id={`${uid}-shift-unit`}
              className={fieldClass}
              value={node.data.unit ?? 'days'}
              onChange={(e) => onChange({ ...node, data: { ...node.data, unit: e.target.value } })}
              aria-label="Time unit"
            >
              {['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'].map((unit) => (
                <option key={unit} value={unit}>{unit}</option>
              ))}
            </select>
          </div>
        </div>
      )}
      {op === 'dateDiff' && (
        <>
          <div>
            <span className={labelClass}>End date</span>
            <TokenTextEditor
              ref={registerEditor('data.to')}
              value={node.data.to ?? ''}
              labelCtx={labelCtx}
              placeholder="The date to count up to"
              onFocus={focusEditor('data.to')}
              onChange={(to) => onChange({ ...node, data: { ...node.data, to: to || undefined } })}
              ariaLabel="End date"
            />
          </div>
          <div>
            <label className={labelClass} htmlFor={`${uid}-diff-unit`}>Count in</label>
            <select
              id={`${uid}-diff-unit`}
              className={fieldClass}
              value={node.data.unit ?? 'days'}
              onChange={(e) => onChange({ ...node, data: { ...node.data, unit: e.target.value } })}
              aria-label="Time unit"
            >
              {['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'].map((unit) => (
                <option key={unit} value={unit}>{unit}</option>
              ))}
            </select>
          </div>
        </>
      )}
      {op === 'datePart' && (
        <div>
          <label className={labelClass} htmlFor={`${uid}-date-part`}>Part to pick</label>
          <select
            id={`${uid}-date-part`}
            className={fieldClass}
            value={node.data.part ?? 'date'}
            onChange={(e) => onChange({ ...node, data: { ...node.data, part: e.target.value } })}
            aria-label="Date part"
          >
            {[
              ['date', 'Calendar date (YYYY-MM-DD)'],
              ['time', 'Time of day (HH:MM)'],
              ['year', 'Year'],
              ['month', 'Month (1–12)'],
              ['day', 'Day of month'],
              ['weekday', 'Weekday name'],
              ['hour', 'Hour'],
              ['minute', 'Minute'],
              ['second', 'Second'],
            ].map(([value, text]) => (
              <option key={value} value={value}>{text}</option>
            ))}
          </select>
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
            <label className={labelClass} htmlFor={`${uid}-limit-count`}>How many to keep</label>
            <input
              id={`${uid}-limit-count`}
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
          <label className={labelClass} htmlFor={`${uid}-aggregate-by`}>Field to collect</label>
          <input
            id={`${uid}-aggregate-by`}
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
          <span className={labelClass}>Calculate</span>
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
                  {SUMMARIZE_OPS.map((o) => (
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
      {(op === 'select' || op === 'compose' || op === 'renameKeys') && (
        <div className="space-y-3">
          <label className={labelClass}>{op === 'renameKeys' ? 'Renames' : 'Fields'}</label>
          {fields.map((field, i) => (
            <div key={i} className="space-y-1.5 rounded-lg border border-border/70 p-2">
              <div className="flex gap-1.5">
                <input
                  className={`${smallField} flex-1`}
                  value={field.name}
                  placeholder={op === 'renameKeys' ? 'Current field name' : 'Output field'}
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => setFields(fields.map((f, j) => (j === i ? { ...f, name: e.target.value } : f)))}
                />
                {fields.length > 1 && (
                  <button type="button" onClick={() => setFields(fields.filter((_, j) => j !== i))} className="px-1 text-red-500 hover:text-red-700" aria-label={op === 'renameKeys' ? 'Remove rename' : 'Remove field'}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
              {op === 'renameKeys' ? (
                <input
                  className={`${smallField} w-full`}
                  value={field.value}
                  placeholder="New field name"
                  onFocus={blockActive}
                  onBlur={unblockActive}
                  onChange={(e) => setFields(fields.map((f, j) => (j === i ? { ...f, value: e.target.value } : f)))}
                  aria-label={`New name for ${field.name || `rename ${i + 1}`}`}
                />
              ) : (
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
              )}
            </div>
          ))}
          <button
            type="button"
            onClick={() => setFields([...fields, { name: '', value: '' }])}
            className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
          >
            <Plus className="h-3.5 w-3.5" /> {op === 'renameKeys' ? 'Add rename' : 'Add field'}
          </button>
          <FieldIssues issues={issueFor('fields')} />
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
  issueFor,
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
  issueFor: (field: string) => FieldIssue[] | undefined
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
      <FieldIssues issues={issueFor('outputFields')} />
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
      <span className={labelClass}>Output fields (optional)</span>
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
        <Plus className="h-3.5 w-3.5" /> Add Field
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
  issueFor,
}: {
  node: Extract<FlowNode, { type: 'subflow' }>
  onChange: (node: FlowNode) => void
  flowId: string
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  dataFields: DataField[]
  insertToken: (token: string) => void
  issueFor: (field: string) => FieldIssue[] | undefined
}) {
  const uid = useId()
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
        <label className={labelClass} htmlFor={`${uid}-subflow-flow`}>Flow to run</label>
        <select
          id={`${uid}-subflow-flow`}
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
          <PanelNotice tone="warning" className="mt-1.5">This flow has never been published — publish it before running it from here.</PanelNotice>
        )}
        <FieldIssues issues={issueFor('flowId')} />
      </div>
      {childFields.length > 0 ? (
        <div className="space-y-2">
          <span className={labelClass}>Inputs it expects</span>
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
          <span className={labelClass}>Input to send it</span>
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

    </>
  )
}

/** Declare the payload fields a manual/scheduled/webhook trigger expects. */
function InputFieldsEditor({ fields, onChange }: { fields: TriggerInputField[]; onChange: (fields: TriggerInputField[]) => void }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
      <span className={labelClass}>Expected input fields</span>
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
