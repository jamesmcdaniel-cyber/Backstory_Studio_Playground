'use client'

import { useId, useRef, useState } from 'react'
import { indentOnTab } from '@/components/ui/textarea'
import { Code2, ListTree, List } from 'lucide-react'
import { DataTree } from '@/components/flows/data-tree'
import type { DataField } from '@/lib/flows/datatree'
import { TokenTextEditor, type TokenTextEditorHandle } from '@/components/flows/token-text-editor'
import type { TokenLabelContext } from '@/lib/flows/token-text'

/** "Pick from a list" (loadOptions parity): run a READ action on the connection
 *  and click a value to drop it into the active argument. No per-field wiring —
 *  any read tool's results are browsable; the API refuses write tools. */
function ResourcePicker({ connectionId, tools, onPick }: { connectionId: string; tools: string[]; onPick: (value: string) => void }) {
  const [tool, setTool] = useState('')
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
        body: JSON.stringify({ connectionId, toolName: tool }),
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
          <select className={`${fieldClass} text-xs`} value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="">Choose a read action…</option>
            {tools.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="button" onClick={load} disabled={!tool || loading} className="whitespace-nowrap rounded-md border border-border px-2.5 text-xs font-medium hover:bg-muted disabled:opacity-50">
            {loading ? 'Loading…' : 'Load'}
          </button>
        </div>
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

type JsonSchema = {
  type?: string
  properties?: Record<string, { type?: string; description?: string; enum?: unknown[] }>
  required?: string[]
}

export type SchemaField = { name: string; type: string; required: boolean; description?: string; enumValues?: string[] }

/** Flatten a tool's top-level JSON-schema object into form fields. */
export function schemaFields(inputSchema: unknown): SchemaField[] {
  const schema = inputSchema as JsonSchema | null
  if (!schema || schema.type !== 'object' || !schema.properties) return []
  const required = new Set(schema.required ?? [])
  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    type: prop.type ?? 'string',
    required: required.has(name),
    description: prop.description,
    enumValues: Array.isArray(prop.enum) ? prop.enum.map(String) : undefined,
  }))
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
  return ['object', 'array', 'any'].includes(field.type)
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
    } else if (field.type === 'number' || field.type === 'integer') {
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
  if (field.description) return field.description
  if (field.type === 'object') return '{"id": "abc123"} or a whole record from Available data'
  if (field.type === 'array') return '["one", "two"] or a list from Available data'
  if (field.type === 'any') return 'Text, JSON, or a value from Available data'
  return 'Add a value or choose one below'
}

const fieldClass =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300'
const labelClass = 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground'

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
  const isFreeText = (field: SchemaField) => !field.enumValues && field.type !== 'boolean'
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
          {fields.map((field) => (
            <div key={field.name}>
              <label className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                <span className="font-mono">{field.name}</span>
                {field.required && <span className="text-red-500">*</span>}
                <span className="text-[10px] uppercase text-muted-foreground">{field.type}</span>
              </label>
              {field.enumValues ? (
                <select
                  className={fieldClass}
                  value={values[field.name] ?? ''}
                  onChange={(e) => setValue(field.name, e.target.value)}
                >
                  <option value="">—</option>
                  {field.enumValues.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : field.type === 'boolean' ? (
                <select
                  className={fieldClass}
                  value={values[field.name] ?? ''}
                  onChange={(e) => setValue(field.name, e.target.value)}
                >
                  <option value="">—</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : isJsonValueField(field) ? (
                <TokenTextEditor
                  ref={registerEditor(field.name)}
                  multiline
                  rows={field.type === 'array' || field.type === 'object' ? 4 : 2}
                  className="font-mono text-xs"
                  value={values[field.name] ?? ''}
                  labelCtx={labelCtx}
                  placeholder={placeholderFor(field)}
                  onFocus={() => {
                    activeArgRef.current = field.name
                  }}
                  onChange={(value) => setValue(field.name, value)}
                  ariaLabel={`Argument ${field.name}`}
                />
              ) : (
                <TokenTextEditor
                  ref={registerEditor(field.name)}
                  value={values[field.name] ?? ''}
                  labelCtx={labelCtx}
                  placeholder={placeholderFor(field)}
                  onFocus={() => {
                    activeArgRef.current = field.name
                  }}
                  onChange={(value) => setValue(field.name, value)}
                  ariaLabel={`Argument ${field.name}`}
                />
              )}
              {field.description && <p className="mt-0.5 text-[11px] text-muted-foreground">{field.description}</p>}
            </div>
          ))}
          <div>
            <DataTree fields={dataFields} onInsert={insert} />
          </div>
          {connectionId && pickerTools && pickerTools.length > 0 && (
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
