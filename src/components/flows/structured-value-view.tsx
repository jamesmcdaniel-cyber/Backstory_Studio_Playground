'use client'

import { useMemo, useState } from 'react'
import { Table2, Braces, Search } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Detect a table shape: an array of objects, or one nested under a common key. */
function tabular(value: unknown): { headers: string[]; rows: Record<string, unknown>[] } | null {
  let arr: unknown = value
  if (!Array.isArray(arr) && value && typeof value === 'object') {
    for (const key of ['items', 'data', 'results', 'records', 'rows']) {
      const candidate = (value as Record<string, unknown>)[key]
      if (Array.isArray(candidate)) {
        arr = candidate
        break
      }
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null
  const hasObject = arr.some((item) => item && typeof item === 'object' && !Array.isArray(item))
  if (!hasObject) return null
  const headers: string[] = []
  for (const item of arr) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const key of Object.keys(item as Record<string, unknown>)) if (!headers.includes(key)) headers.push(key)
    }
  }
  const rows = arr.map((item) =>
    item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : { value: item },
  )
  return { headers, rows }
}

const cellText = (value: unknown): string =>
  value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)

/**
 * Structured output viewer with a Table/JSON toggle and in-panel search — the
 * n8n RunData parity for the builder. Table mode is the default whenever the
 * value is (or contains) a list of records; otherwise JSON. Search filters
 * table rows / JSON lines by substring.
 */
export function StructuredValueView({ value, maxHeight = 'max-h-64' }: { value: unknown; maxHeight?: string }) {
  const table = useMemo(() => tabular(value), [value])
  const [mode, setMode] = useState<'table' | 'json'>(table ? 'table' : 'json')
  const [query, setQuery] = useState('')
  const json = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }, [value])

  const q = query.trim().toLowerCase()
  const rows = useMemo(() => {
    if (!table) return []
    if (!q) return table.rows
    return table.rows.filter((row) => table.headers.some((h) => cellText(row[h]).toLowerCase().includes(q)))
  }, [table, q])
  const jsonLines = useMemo(() => {
    if (!q) return json
    return json.split('\n').filter((line) => line.toLowerCase().includes(q)).join('\n') || '(no matching lines)'
  }, [json, q])

  const effectiveMode = table ? mode : 'json'
  const btn = 'flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium'

  return (
    <div className="rounded border border-border/60 bg-background">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        {table && (
          <div className="flex items-center gap-0.5 rounded bg-muted p-0.5">
            <button type="button" className={cn(btn, effectiveMode === 'table' ? 'bg-background shadow-sm' : 'text-muted-foreground')} onClick={() => setMode('table')}>
              <Table2 className="h-3 w-3" /> Table
            </button>
            <button type="button" className={cn(btn, effectiveMode === 'json' ? 'bg-background shadow-sm' : 'text-muted-foreground')} onClick={() => setMode('json')}>
              <Braces className="h-3 w-3" /> JSON
            </button>
          </div>
        )}
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="h-6 w-32 rounded border border-border/60 bg-background pl-6 pr-1.5 text-[11px] outline-none focus:border-indigo-400"
          />
        </div>
        {table && <span className="text-[11px] text-muted-foreground">{rows.length}/{table.rows.length}</span>}
      </div>
      {effectiveMode === 'table' && table ? (
        <div className={cn('overflow-auto', maxHeight)}>
          <table className="w-full border-collapse text-[11px]">
            <thead className="sticky top-0 bg-muted/80 backdrop-blur">
              <tr>
                {table.headers.map((h) => (
                  <th key={h} className="border-b border-border/60 px-2 py-1 text-left font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="odd:bg-muted/30">
                  {table.headers.map((h) => (
                    <td key={h} className="max-w-[220px] truncate border-b border-border/40 px-2 py-1" title={cellText(row[h])}>{cellText(row[h])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <pre className={cn('overflow-auto px-2 py-1.5 text-xs', maxHeight)}>{jsonLines}</pre>
      )}
    </div>
  )
}
