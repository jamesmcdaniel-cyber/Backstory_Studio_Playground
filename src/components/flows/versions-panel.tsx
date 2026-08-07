'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { changeSummaryText, type GraphChangeSummary } from '@/lib/flows/edit-summary'

type VersionRow = {
  id: string
  version: number
  note?: string | null
  summary?: GraphChangeSummary | null
  publishedAt: string
  publishedBy?: string | null
  publishedByName?: string | null
}

type EditRow = {
  id: string
  at: string
  by: string
  detail?: {
    fields?: string[]
    nodes?: number
    edges?: number
    restoredFromVersion?: number
    restoredFromEditAt?: string
    snapshotId?: string
    summary?: GraphChangeSummary | null
  } | null
}

/** The best one-line "what changed" for an edit row, oldest fallbacks last. */
function editChangeText(edit: EditRow): string {
  const detail = edit.detail
  if (!detail) return ''
  const prefix =
    detail.restoredFromVersion != null
      ? `restored v${detail.restoredFromVersion}`
      : detail.restoredFromEditAt
        ? `restored the canvas from ${new Date(detail.restoredFromEditAt).toLocaleString()}`
        : ''
  const summary = changeSummaryText(detail.summary)
  if (prefix && summary) return `${prefix} — ${summary}`
  if (prefix || summary) return prefix || summary
  // Pre-summary rows: fall back to the coarse field list / step count.
  if (detail.fields?.length) return detail.fields.map((field) => (field === 'graph' ? 'canvas' : field)).join(', ')
  if (detail.nodes != null) return `${detail.nodes} step${detail.nodes === 1 ? '' : 's'}`
  return ''
}

export function VersionsPanel({
  flowId,
  currentVersion,
  onView,
  onViewEdit,
  onRestore,
  onClose,
}: {
  flowId: string
  currentVersion: number
  onView: (version: number) => void
  onViewEdit: (snapshotId: string, at: string) => void
  onRestore: (version: number) => void
  onClose: () => void
}) {
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [recentEdits, setRecentEdits] = useState<EditRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/flows/${flowId}/versions`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.success) {
          setVersions(data.versions)
          setRecentEdits(data.recentEdits ?? [])
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [flowId])

  return (
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Version history</h2>
        <button type="button" onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {!loading && recentEdits.length > 0 && (
          <div className="border-b border-border/60 px-3 py-2.5">
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent edits</p>
            <ul className="space-y-0.5">
              {recentEdits.slice(0, 8).map((edit) => {
                const snapshotId = edit.detail?.snapshotId
                const change = editChangeText(edit)
                const body = (
                  <>
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium text-foreground">{edit.by}</span>
                      <span className="shrink-0 text-muted-foreground">{new Date(edit.at).toLocaleString()}</span>
                    </span>
                    {change && <span className="mt-0.5 block truncate text-muted-foreground">{change}</span>}
                  </>
                )
                return (
                  <li key={edit.id}>
                    {snapshotId ? (
                      <button
                        type="button"
                        onClick={() => onViewEdit(snapshotId, edit.at)}
                        title="View the flow as of this edit (read-only, restorable)"
                        className="-mx-1.5 block w-[calc(100%+12px)] rounded-md px-1.5 py-1 text-left text-xs hover:bg-muted/60"
                      >
                        {body}
                      </button>
                    ) : (
                      // Edits recorded before per-edit snapshots existed have
                      // nothing stored to open — plain row, no dead click.
                      <div className="px-0 py-1 text-xs" title="Made before edit snapshots — nothing stored to view">
                        {body}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        )}
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : versions.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {recentEdits.length > 0
              ? 'Click an edit above to see the flow at that moment. Publishing also snapshots a numbered version here.'
              : 'Edits and published versions will appear here.'}
          </p>
        ) : (
          versions.map((row) => {
            const isCurrent = row.version === currentVersion
            const change = changeSummaryText(row.summary)
            return (
              <div
                key={row.id}
                className={cn('flex items-center gap-2 border-b border-border/60 px-3 py-2.5 last:border-0', isCurrent && 'bg-muted/40')}
              >
                <button
                  type="button"
                  onClick={() => onView(row.version)}
                  title={`View v${row.version} (read-only)`}
                  className="min-w-0 flex-1 rounded-md text-left hover:bg-muted/40"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium">v{row.version}</span>
                    {isCurrent && <Badge variant="secondary">Current</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {new Date(row.publishedAt).toLocaleString()}
                    {row.publishedByName ? ` · by ${row.publishedByName}` : ''}
                    {row.note ? ` · ${row.note}` : ''}
                  </p>
                  {change && <p className="truncate text-xs text-muted-foreground">{change}</p>}
                </button>
                <Button variant="ghost" size="sm" onClick={() => onView(row.version)}>
                  View
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (window.confirm(`Restore v${row.version} into the draft? Your current draft is replaced (undo with ⌘Z).`)) {
                      onRestore(row.version)
                    }
                  }}
                >
                  Restore
                </Button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
