'use client'

/**
 * Step-editor primitives shared by the drawer and the per-step-kind field
 * components carved out of it (./http-step-fields and its siblings).
 *
 * They live here rather than in step-drawer.tsx so a child does not have to
 * import from its own parent: that cycle works at runtime, because everything
 * here is read at render time rather than module init, but it makes the
 * dependency direction a lie and breaks the moment something is read eagerly.
 */

import { useId, useState } from 'react'
import { DataTree } from '@/components/flows/data-tree'
import { TokenTextEditor, type TokenTextEditorHandle } from '@/components/flows/token-text-editor'
import { Button } from '@/components/ui/button'
import { type DataField } from '@/lib/flows/datatree'
import { type FormFileBinding } from '@/lib/flows/file-ref'
import { type FlowNode } from '@/lib/flows/graph'
import { type FieldIssue } from '@/lib/flows/issue-fields'
import { type TokenLabelContext } from '@/lib/flows/token-text'
import { cn } from '@/lib/utils'
import { AlertTriangle, Plus, Trash2 } from 'lucide-react'

export type ToolCatalog = { id: string; name: string; serverUrl?: string; tools: { name: string; description: string; inputSchema?: unknown; outputSchema?: unknown }[]; toolsError?: string }[]

export const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
// Textareas: comfortable default height, user-resizable vertically.
export const areaClass = `${fieldClass} min-h-[120px] resize-y`
export const smallField =
  'rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
export const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

export function cleanOptimize(next: { dataPath?: string; fields?: string[]; maxItems?: number }): { dataPath?: string; fields?: string[]; maxItems?: number } | undefined {
  const fields = (next.fields ?? []).filter((f) => f.trim())
  const cleaned = { ...next, fields: fields.length ? fields : undefined }
  return cleaned.dataPath || cleaned.fields || cleaned.maxItems ? cleaned : undefined
}

export type PerItemConfigLike = { over: string; itemError?: 'fail' | 'skip' | 'collect'; concurrency?: number }

export function PerItemSection({
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

export function FormFileFields({
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

export type KeyValueRow = { key: string; value: string }

export function parseKeyValueRows(value: string | undefined): { rows: KeyValueRow[]; invalid: boolean } {
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

export function parseTypedValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (!/^(?:true|false|null|-?\d|\{|\[|")/.test(trimmed)) return value
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

export function serializeKeyValueRows(rows: KeyValueRow[]): string | undefined {
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (!key) continue
    out[key] = parseTypedValue(row.value)
  }
  return Object.keys(out).length ? JSON.stringify(out, null, 2) : undefined
}

export function KeyValueJsonEditor({
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

export function FieldIssues({ issues }: { issues: FieldIssue[] | undefined }) {
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

export type TokenEditorPlumbing = {
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  registerEditor: (key: string) => (handle: TokenTextEditorHandle | null) => void
  focusEditor: (key: string) => () => void
  insertToken: (token: string) => void
  blockActive: () => void
  unblockActive: () => void
}

// Step-kind vocabulary, shared by the drawer chrome and the field components.
export type EditableType = Extract<FlowNode['type'], 'agent' | 'ai' | 'subflow' | 'knowledge' | 'code' | 'condition' | 'loop' | 'parallel' | 'stop' | 'tool' | 'http' | 'transform' | 'filter' | 'switch' | 'variable' | 'data' | 'humanReview' | 'output' | 'join'>

export const NODE_TYPES: { value: EditableType; label: string }[] = [
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

export const AGENT_STEP_MODELS = ['claude-sonnet-5', 'claude-opus-4-8', 'claude-haiku-4-5']

export type OrgMember = { id: string; name: string | null; email: string | null }

export function orgMemberLabel(member: OrgMember): string {
  return member.name?.trim() || member.email?.trim() || 'Member'
}

export const DEFAULT_EDITOR_KEYS: Partial<Record<FlowNode['type'], string>> = {
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

export const NON_TOKEN_FOCUSED = 'non-token-focused'
