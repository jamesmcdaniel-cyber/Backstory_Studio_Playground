'use client'

import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

type VersionRow = {
  id: string
  version: number
  note?: string | null
  publishedAt: string
  publishedBy?: string | null
  publishedByName?: string | null
}

export function VersionsPanel({
  flowId,
  currentVersion,
  onView,
  onRestore,
  onClose,
}: {
  flowId: string
  currentVersion: number
  onView: (version: number) => void
  onRestore: (version: number) => void
  onClose: () => void
}) {
  const [versions, setVersions] = useState<VersionRow[]>([])
  const [recentEdits, setRecentEdits] = useState<{ id: string; at: string; by: string; detail?: { fields?: string[]; nodes?: number; edges?: number; restoredFromVersion?: number } | null }[]>([])
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
            <ul className="space-y-1">
              {recentEdits.slice(0, 8).map((edit) => (
                <li key={edit.id} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate">
                    <span className="font-medium text-foreground">{edit.by}</span>
                    {edit.detail?.restoredFromVersion != null
                      ? ` · restored v${edit.detail.restoredFromVersion}`
                      : edit.detail?.fields?.length
                      ? ` · ${edit.detail.fields.map((field) => field === 'graph' ? 'canvas' : field).join(', ')}`
                      : edit.detail?.nodes != null
                        ? ` · ${edit.detail.nodes} step${edit.detail.nodes === 1 ? '' : 's'}`
                        : ''}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{new Date(edit.at).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : versions.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {recentEdits.length > 0 ? 'Publish the flow to snapshot a restorable version.' : 'Edits and published versions will appear here.'}
          </p>
        ) : (
          versions.map((row) => {
            const isCurrent = row.version === currentVersion
            return (
              <div
                key={row.id}
                className={cn('flex items-center gap-2 border-b border-border/60 px-3 py-2.5 last:border-0', isCurrent && 'bg-muted/40')}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium">v{row.version}</span>
                    {isCurrent && <Badge variant="secondary">Current</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {new Date(row.publishedAt).toLocaleString()}
                    {row.publishedByName ? ` · by ${row.publishedByName}` : ''}
                    {row.note ? ` · ${row.note}` : ''}
                  </p>
                </div>
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
