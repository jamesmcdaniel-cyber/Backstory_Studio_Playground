'use client'

import { useId, useRef, useState } from 'react'
import { indentOnTab } from '@/components/ui/textarea'
import { Code2, ListTree, List, ChevronDown } from 'lucide-react'
import { DataTree } from '@/components/flows/data-tree'
import type { DataField } from '@/lib/flows/datatree'
import { TokenTextEditor, type TokenTextEditorHandle } from '@/components/flows/token-text-editor'
import type { TokenLabelContext } from '@/lib/flows/token-text'
import { toolFields, type ToolField, type ToolFieldOption } from '@/lib/flows/tool-schema'
import { humanizeToolName } from '@/lib/flows/humanize-tool-name'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'

/** "Pick from a list" (loadOptions parity): run a READ action on the connection
 *  and click a value to drop it into the active argument. No per-field wiring —
 *  any read tool's results are browsable; the API refuses write tools. */
function ResourcePicker({ connectionId, tools, onPick }: { connectionId: string; tools: string[]; onPick: (value: string) => void }) {
  const [tool, setTool] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<Record<string, unknown>[] | null>(null)
  const load = async () => {
    if (!tool) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/flows/tool-options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // A search term, which the endpoint has always accepted and this picker
        // never sent — so any read action that takes a query (`find_account`,
        // `search_records`) could only ever be called with no arguments and
        // came back empty. Sent under the names a read tool actually uses.
        body: JSON.stringify({
          connectionId,
          toolName: tool,
          ...(search.trim() ? { args: { query: search.trim(), search: search.trim(), name: search.trim() } } : {}),
        }),
      }).then((r) => r.json())
      if (!res?.success) {
        setError(res?.error || 'Could not load the list.')
        setRows([])
      } else {
        setRows((res.items as unknown[]).map((it) => (it && typeof it === 'object' && !Array.isArray(it) ? (it as Record<string, unknown>) : { value: it })))
      }
    } catch {
      setError('Could not load the list.')
      setRows([])
    } finally {
      setLoading(false)
    }
  }
  const headers = rows && rows.length ? Array.from(new Set(rows.flatMap((r) => Object.keys(r)))).slice(0, 6) : []
  const cell = (v: unknown) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  return (
    <details className="rounded-lg border border-border/70 p-2">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-muted-foreground"><List className="h-3.5 w-3.5" /> Pick from a list</summary>
      <div className="mt-2 space-y-2">
        <div className="flex gap-2">
          <select className={`${fieldClass} text-xs`} value={tool} onChange={(e) => setTool(e.target.value)} aria-label="Read action">
            <option value="">Choose a read action…</option>
            {tools.map((t) => <option key={t} value={t}>{humanizeToolName(t)}</option>)}
          </select>
          <button type="button" onClick={load} disabled={!tool || loading} className="whitespace-nowrap rounded-md border border-border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
            {loading ? 'Loading…' : 'Load'}
          </button>
        </div>
        <input
          className={`${fieldClass} text-xs`}
          value={search}
          placeholder="Search for… (leave empty to list everything)"
          aria-label="Search the list"
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void load() } }}
        />
        {error && <p className="text-xs text-red-600">{error}</p>}
        {rows && rows.length > 0 && (
          <div className="max-h-48 overflow-auto rounded border border-border/60">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-muted/80"><tr>{headers.map((h) => <th key={h} className="px-2 py-1 text-left font-semibold">{h}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="odd:bg-muted/30">
                    {headers.map((h) => (
                      <td key={h} className="cursor-pointer px-2 py-1 hover:bg-indigo-50 dark:hover:bg-indigo-500/10" title="Click to use this value" onClick={() => onPick(cell(r[h]))}>{cell(r[h])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {rows && rows.length === 0 && !error && <p className="text-xs text-muted-foreground">No items returned.</p>}
        <p className="text-[11px] text-muted-foreground">Click a value to drop it into the highlighted argument.</p>
      </div>
    </details>
  )
}

/**
 * Whether "pick from a list" can serve this connection at all.
 *
 * Mirrors the refusal in /api/flows/tool-options, which is a safety rule, not
 * an oversight: the MCP and People.ai executors cannot classify a tool as read
 * or write, so the endpoint will not run one on a picker's behalf.
 */
function canPickFromList(connectionId: string): boolean {
  const { plane } = parseFlowToolConnectionId(connectionId)
  return plane !== 'mcp' && plane !== 'people_ai'
}

export type SchemaField = ToolField

/**
 * A tool's arguments as typed form fields.
 *
 * Delegates to the JSON-Schema reader — unions, $refs, bounds, formats and
 * defaults all carry meaning the old one-level flatten dropped on the floor.
 */
export function schemaFields(inputSchema: unknown): SchemaField[] {
  return toolFields(inputSchema)
}

export function parseArgs(args: string | undefined): Record<string, string> {
  if (!args) return {}
  try {
    const parsed = JSON.parse(args)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) out[k] = typeof v === 'string' ? v : JSON.stringify(v)
      return out
    }
  } catch {
    /* not JSON yet */
  }
  return {}
}

function parseJsonLike(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (!/^(?:true|false|null|-?\d|\{|\[|")/.test(trimmed)) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function isJsonValueField(field: SchemaField): boolean {
  return field.type === 'object' || field.type === 'array' || field.type === 'any' || field.type === 'multiEnum'
}

/** Re-serialize form values to a JSON args string, coercing where the schema says so. */
export function serializeArgs(values: Record<string, string>, fields: SchemaField[]): string {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const raw = values[field.name]
    if (raw === undefined || raw === '') continue
    const parsed = isJsonValueField(field) ? parseJsonLike(raw) : undefined
    if (parsed !== undefined) {
      out[field.name] = parsed
    } else if (raw.includes('{{')) {
      // Exact-token object/array values are preserved by resolveTemplateValue at runtime.
      out[field.name] = raw
    } else if (field.type === 'number') {
      const n = Number(raw)
      out[field.name] = Number.isNaN(n) ? raw : n
    } else if (field.type === 'boolean') {
      out[field.name] = raw === 'true'
    } else {
      out[field.name] = raw
    }
  }
  return JSON.stringify(out, null, 2)
}

function placeholderFor(field: SchemaField): string {
  if (field.default !== undefined) {
    return `Defaults to ${typeof field.default === 'string' ? field.default : JSON.stringify(field.default)}`
  }
  if (field.type === 'number' && (field.min !== undefined || field.max !== undefined)) {
    if (field.min !== undefined && field.max !== undefined) return `A number from ${field.min} to ${field.max}`
    if (field.min !== undefined) return `${field.min} or more`
    return `${field.max} or less`
  }
  if (field.type === 'dateTime') return 'A date and time, or a date from Available data'
  if (field.type === 'object') return '{"id": "abc123"} or a whole record from Available data'
  if (field.type === 'array' || field.type === 'multiEnum') return '["one", "two"] or a list from Available data'
  if (field.type === 'any') return 'Text, JSON, or a value from Available data'
  if (field.description) return field.description
  return 'Add a value or choose one below'
}

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

/**
 * One argument, rendered as the control its schema actually describes.
 *
 * Everything used to be a text box: an enum, a bounded integer, a date and a
 * free string all looked identical and accepted anything. The schema knows
 * better than that, and a control that knows what it accepts is the difference
 * between a form and a guess.
 *
 * The token editor stays the fallback for every free value, because binding a
 * field to earlier flow data is the point of the builder — a typed control that
 * could not hold `{{…}}` would trade one capability for another. Enum and
 * boolean fields, which are closed sets, get "Use flow data" instead so that
 * binding is still reachable.
 */
function ArgField({
  field,
  value,
  labelCtx,
  registerEditor,
  onFocusField,
  onChange,
}: {
  field: SchemaField
  value: string
  labelCtx: TokenLabelContext
  registerEditor: (name: string) => (handle: TokenTextEditorHandle | null) => void
  onFocusField: () => void
  onChange: (value: string) => void
}) {
  const bound = value.includes('{{')
  const [freeform, setFreeform] = useState(bound)
  const closedSet = field.type === 'enum' || field.type === 'boolean'
  const options: ToolFieldOption[] = field.type === 'boolean'
    ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
    : field.options ?? []
  const outOfRange =
    field.type === 'number' && !bound && value !== '' && Number.isFinite(Number(value))
      ? (field.min !== undefined && Number(value) < field.min) || (field.max !== undefined && Number(value) > field.max)
      : false

  const editor = (multiline: boolean) => (
    <TokenTextEditor
      ref={registerEditor(field.name)}
      multiline={multiline}
      rows={multiline ? 4 : undefined}
      className={multiline ? 'font-mono text-xs' : undefined}
      value={value}
      labelCtx={labelCtx}
      placeholder={placeholderFor(field)}
      onFocus={onFocusField}
      onChange={onChange}
      ariaLabel={`Argument ${field.label}`}
    />
  )

  return (
    <div>
      <label className="mb-1 flex flex-wrap items-center gap-1.5 text-xs font-medium">
        <span>{field.label}</span>
        {field.required && <span className="text-red-500" title="Required">*</span>}
        {/* The wire key stays visible: the label is for reading, this is what
            the tool receives and what an error message will name. */}
        {field.label.toLowerCase() !== field.name.toLowerCase() && (
          <span className="font-mono text-[10px] text-muted-foreground">{field.name}</span>
        )}
        {closedSet && (
          <button
            type="button"
            onClick={() => setFreeform((current) => !current)}
            className="ml-auto text-[10px] font-medium text-muted-foreground hover:text-indigo-600"
          >
            {freeform ? 'Choose a value' : 'Use flow data'}
          </button>
        )}
      </label>

      {closedSet && !freeform ? (
        <select className={fieldClass} value={value} onChange={(event) => onChange(event.target.value)} aria-label={`Argument ${field.label}`}>
          <option value="">{field.default !== undefined ? `Default — ${String(field.default)}` : '—'}</option>
          {options.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : field.type === 'dateTime' && !bound ? (
        <input
          type="datetime-local"
          className={fieldClass}
          value={value}
          onFocus={onFocusField}
          onChange={(event) => onChange(event.target.value)}
          aria-label={`Argument ${field.label}`}
        />
      ) : isJsonValueField(field) ? (
        editor(true)
      ) : (
        editor(false)
      )}

      {outOfRange && (
        <p className="mt-0.5 text-[11px] text-amber-700">
          {field.min !== undefined && field.max !== undefined
            ? `${field.label} accepts ${field.min} to ${field.max}.`
            : field.min !== undefined
              ? `${field.label} accepts ${field.min} or more.`
              : `${field.label} accepts ${field.max} or less.`}
        </p>
      )}
      {field.description && <p className="mt-0.5 text-[11px] text-muted-foreground">{field.description}</p>}
    </div>
  )
}

/**
 * Renders a tool's arguments from its JSON-schema as real form fields (with a
 * datatree token picker), or falls back to a raw-JSON editor for tools whose
 * schema is unknown or when the user opts into advanced mode.
 */
export function ToolArgsEditor({
  inputSchema,
  args,
  onChange,
  dataFields,
  labelCtx,
  connectionId,
  pickerTools,
}: {
  inputSchema: unknown
  args: string | undefined
  onChange: (nextArgs: string) => void
  dataFields: DataField[]
  labelCtx: TokenLabelContext
  /** For the "pick from a list" resource picker: the connection + its read tools. */
  connectionId?: string
  pickerTools?: string[]
}) {
  const fields = schemaFields(inputSchema)
  const [raw, setRaw] = useState(fields.length === 0)
  // Chip-editor handles per free-text arg; the datatree inserts a token chip at
  // the caret of the last-focused one (first free-text arg before any focus).
  const editorHandles = useRef<Map<string, TokenTextEditorHandle | null>>(new Map())
  const editorRefCallbacks = useRef<Map<string, (handle: TokenTextEditorHandle | null) => void>>(new Map())
  const activeArgRef = useRef<string | null>(null)
  const registerEditor = (name: string) => {
    let callback = editorRefCallbacks.current.get(name)
    if (!callback) {
      callback = (handle: TokenTextEditorHandle | null) => {
        editorHandles.current.set(name, handle)
      }
      editorRefCallbacks.current.set(name, callback)
    }
    return callback
  }
  const rawElRef = useRef<HTMLTextAreaElement | null>(null)
  const rawArgsId = useId()

  const values = parseArgs(args)
  const setValue = (name: string, value: string) => onChange(serializeArgs({ ...values, [name]: value }, fields))
  const requiredFields = fields.filter((field) => field.required)
  const optionalFields = fields.filter((field) => !field.required)
  const setOptionalCount = optionalFields.filter((field) => (values[field.name] ?? '') !== '').length
  const [showOptional, setShowOptional] = useState(false)
  // An optional argument that already has a value is never hidden — folding
  // away something the step actually sends would make the form lie.
  const shownFields = showOptional
    ? fields
    : [...requiredFields, ...optionalFields.filter((field) => (values[field.name] ?? '') !== '')]
  const insertAtCaret = (value: string, token: string, el: HTMLTextAreaElement | null) => {
    if (!el || typeof el.selectionStart !== 'number') return value + token
    const start = el.selectionStart
    const end = el.selectionEnd ?? start
    const next = value.slice(0, start) + token + value.slice(end)
    const pos = start + token.length
    requestAnimationFrame(() => {
      try {
        el.focus()
        el.setSelectionRange(pos, pos)
      } catch {
        /* element unmounted */
      }
    })
    return next
  }
  const isFreeText = (field: SchemaField) => field.type !== 'enum' && field.type !== 'boolean'
  // DataTree emits braced `{{token}}`s; the chip editor takes the bare path.
  const insert = (token: string) => {
    if (raw || fields.length === 0) {
      onChange(insertAtCaret(args ?? '{}', token, rawElRef.current))
      return
    }
    const path = token.startsWith('{{') && token.endsWith('}}') ? token.slice(2, -2).trim() : token
    const active = activeArgRef.current ? editorHandles.current.get(activeArgRef.current) : null
    const fallback = fields.find(isFreeText)?.name
    const editor = active ?? (fallback ? editorHandles.current.get(fallback) : null)
    editor?.insertToken(path)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className={`${labelClass} mb-0`} htmlFor={rawArgsId}>Arguments</label>
        {fields.length > 0 && (
          <button
            type="button"
            onClick={() => setRaw((v) => !v)}
            className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-indigo-600"
          >
            {raw ? <ListTree className="h-3 w-3" /> : <Code2 className="h-3 w-3" />}
            {raw ? 'Form' : 'Raw JSON'}
          </button>
        )}
      </div>

      {raw || fields.length === 0 ? (
        <div className="space-y-2">
          <textarea
            id={rawArgsId}
            ref={rawElRef}
            rows={5}
            onKeyDown={indentOnTab}
            className={`${fieldClass} min-h-[120px] resize-y font-mono text-xs`}
            value={args ?? '{}'}
            placeholder={'{"query": "Use a value from Available data"}'}
            onChange={(e) => onChange(e.target.value)}
          />
          <DataTree fields={dataFields} onInsert={insert} />
        </div>
      ) : (
        <div className="space-y-3">
          {shownFields.map((field) => (
            <ArgField
              key={field.name}
              field={field}
              value={values[field.name] ?? ''}
              labelCtx={labelCtx}
              registerEditor={registerEditor}
              onFocusField={() => {
                activeArgRef.current = field.name
              }}
              onChange={(value) => setValue(field.name, value)}
            />
          ))}
          {/* Optional arguments stay folded away. A tool with a dozen of them
              rendered a wall of empty boxes with the two that matter buried in
              it, and every one of those boxes reads as something to fill in. */}
          {optionalFields.length > 0 && (
            <button
              type="button"
              onClick={() => setShowOptional((value) => !value)}
              className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-700"
            >
              {showOptional ? <ChevronDown className="h-3.5 w-3.5 rotate-180" /> : <ChevronDown className="h-3.5 w-3.5" />}
              {showOptional
                ? 'Hide optional settings'
                : `${optionalFields.length} optional setting${optionalFields.length === 1 ? '' : 's'}${setOptionalCount ? ` · ${setOptionalCount} set` : ''}`}
            </button>
          )}
          <div>
            <DataTree fields={dataFields} onInsert={insert} />
          </div>
          {/* Only where it can actually answer. The endpoint refuses MCP and
              People.ai connections on purpose — those executors report
              isWrite:false for every tool, so a "picker" call there could fire
              an arbitrary side effect — but the control rendered anyway and
              failed at Load with an error. A dead end is worse than an absence;
              the schema's own description still says how to get the value. */}
          {connectionId && canPickFromList(connectionId) && pickerTools && pickerTools.length > 0 && (
            <ResourcePicker
              connectionId={connectionId}
              tools={pickerTools}
              onPick={(value) => {
                const target = activeArgRef.current ?? fields.find(isFreeText)?.name
                if (target) setValue(target, value)
              }}
            />
          )}
        </div>
      )}
    </div>
  )
}
