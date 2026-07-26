'use client'

import { useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataField } from '@/lib/flows/datatree'

function FieldRow({ field, depth, onInsert }: { field: DataField; depth: number; onInsert: (token: string) => void }) {
  const [open, setOpen] = useState(depth === 0)
  const hasChildren = Boolean(field.children && field.children.length)
  return (
    <div>
      <div className="flex items-start gap-1" style={{ paddingLeft: depth * 12 }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="mt-2 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={open ? 'Collapse' : 'Expand'}
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        ) : (
          <span className="w-4" />
        )}
        <button
          type="button"
          // Keep focus (and the caret) on the input the user was editing so the
          // token inserts at the cursor instead of stealing focus.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert(field.token)}
          title={`Insert ${field.token}`}
          className="group flex min-w-0 flex-1 items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-indigo-50 dark:hover:bg-indigo-500/10"
        >
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border border-border bg-background text-muted-foreground group-hover:border-indigo-200 group-hover:text-indigo-600">
            <Plus className="h-3 w-3" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-xs font-medium text-foreground">{field.label}</span>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase text-muted-foreground">{field.type}</span>
            </span>
            {field.description && <span className="mt-0.5 block line-clamp-2 text-[11px] leading-4 text-muted-foreground">{field.description}</span>}
          </span>
        </button>
      </div>
      {open && hasChildren && field.children!.map((child) => <FieldRow key={child.token} field={child} depth={depth + 1} onInsert={onInsert} />)}
    </div>
  )
}

/** A datatree / datapill picker — click a field to insert its {{token}}. */
export function DataTree({
  fields,
  onInsert,
  title = 'Available data',
  emptyMessage = 'No earlier step data is available yet.',
}: {
  fields: DataField[]
  onInsert: (token: string) => void
  title?: string
  emptyMessage?: string
}) {
  if (fields.length === 0) return <p data-flow-data-tree className="rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">{emptyMessage}</p>
  return (
    <div data-flow-data-tree className="rounded-lg border border-border bg-background">
      <div className="border-b border-border px-3 py-2">
        <p className="text-xs font-semibold text-foreground">{title}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">Click a value to add it to the field you are editing.</p>
      </div>
      <div className="max-h-64 overflow-y-auto p-1.5">
        {fields.map((field) => (
          <FieldRow key={field.token} field={field} depth={0} onInsert={onInsert} />
        ))}
      </div>
    </div>
  )
}
