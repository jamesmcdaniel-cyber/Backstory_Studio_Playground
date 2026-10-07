'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, ChevronRight, Columns3, Folder, FolderOpen, History, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { badgeVariants } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { compareRuns, groupRunsByAccount, runStatus, type RoiAccountFolder } from '@/lib/roi/history'
import type { RoiAnalysisView } from '@/lib/roi/types'

function folderKey(account: string): string {
  return account.trim().toLowerCase()
}

function absoluteDate(iso: string, withTime = true): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString(undefined, withTime ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "2h ago" while it says more than the date does; nothing once relativeTime falls back to a date. */
function recentLabel(iso: string): string | null {
  const relative = relativeTime(iso)
  return relative === 'just now' || relative.endsWith('ago') ? relative : null
}

/**
 * Every analysis run from the page, in one folder per account (the most
 * recently run first). A completed run opens its report; an account with two
 * or more completed runs can put their headline numbers side by side.
 */
/** Opens a finished run's version of the report in place (the ROI page); without it, runs link to their artifact. */
type OpenRun = (run: RoiAnalysisView) => void

export function RunHistory({ analyses, error, onOpenRun, compact = false }: { analyses: RoiAnalysisView[] | null; error?: string | null; onOpenRun?: OpenRun; compact?: boolean }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [comparing, setComparing] = useState<Record<string, boolean>>({})
  const folders = useMemo(() => groupRunsByAccount(analyses ?? [], query), [analyses, query])
  const searching = Boolean(query.trim())

  return (
    <section aria-labelledby="roi-history-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="roi-history-heading" className={cn('font-semibold tracking-tight', compact ? 'text-sm' : 'text-lg')}>Run history</h2>
          <p className={cn('text-muted-foreground', compact ? 'text-xs' : 'text-sm')}>Every run, by account: settings changes and data refreshes. Open one to see that version.</p>
        </div>
        {analyses && analyses.length > 0 && (
          <div className={cn('relative w-full', !compact && 'sm:w-64')}>
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" aria-hidden />
            <label htmlFor="roi-history-search" className="sr-only">Search accounts</label>
            <Input id="roi-history-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search accounts" className="pl-8" />
          </div>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      {analyses === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>
      ) : analyses.length === 0 ? (
        <EmptyState icon={History} title="No analyses yet" description="Runs from this page appear here, grouped by account." />
      ) : folders.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No account matches “{query.trim()}”.</p>
      ) : (
        <ul className="space-y-2">
          {folders.map((folder, index) => {
            const key = folderKey(folder.account)
            const isOpen = open[key] ?? (searching || index === 0)
            const canCompare = folder.completed >= 2
            const isComparing = canCompare && Boolean(comparing[key])
            return (
              <li key={key}>
                <AccountFolder
                  folder={folder}
                  isOpen={isOpen}
                  canCompare={canCompare}
                  isComparing={isComparing}
                  onToggle={() => setOpen((current) => ({ ...current, [key]: !isOpen }))}
                  onToggleCompare={() => {
                    setComparing((current) => ({ ...current, [key]: !isComparing }))
                    if (!isComparing) setOpen((current) => ({ ...current, [key]: true }))
                  }}
                  onOpenRun={onOpenRun}
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function AccountFolder({ folder, isOpen, canCompare, isComparing, onToggle, onToggleCompare, onOpenRun }: {
  folder: RoiAccountFolder
  onOpenRun?: OpenRun
  isOpen: boolean
  canCompare: boolean
  isComparing: boolean
  onToggle: () => void
  onToggleCompare: () => void
}) {
  const panelId = `roi-folder-${folderKey(folder.account).replace(/[^a-z0-9]+/g, '-')}`
  const FolderIcon = isOpen ? FolderOpen : Folder
  const count = folder.runs.length
  return (
    <div className="rounded-xl border bg-card shadow-1">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-4">
        <button
          type="button"
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-fast', isOpen && 'rotate-90')} aria-hidden />
          <FolderIcon className="h-4 w-4 shrink-0 text-horizon-600" aria-hidden />
          <span className="truncate font-medium">{folder.account}</span>
          <span className={cn(badgeVariants({ variant: 'secondary' }), 'shrink-0 px-2 font-mono tabular-nums')}>
            {count}<span className="sr-only"> {count === 1 ? 'run' : 'runs'}</span>
          </span>
          <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground sm:inline">Last run {relativeTime(folder.lastRunAt)}</span>
        </button>
        {canCompare && (
          <Button type="button" variant={isComparing ? 'secondary' : 'outline'} size="sm" aria-pressed={isComparing} onClick={onToggleCompare}>
            <Columns3 className="h-3.5 w-3.5" aria-hidden />Compare runs
          </Button>
        )}
      </div>
      {isOpen && (
        <div id={panelId} className="border-t">
          {isComparing && <RunComparison account={folder.account} runs={folder.runs} onOpenRun={onOpenRun} />}
          <ul className="divide-y">
            {folder.runs.map((run) => <RunRow key={run.id} run={run} onOpenRun={onOpenRun} />)}
          </ul>
        </div>
      )}
    </div>
  )
}

function RunRow({ run, onOpenRun }: { run: RoiAnalysisView; onOpenRun?: OpenRun }) {
  const status = runStatus(run.phase)
  const recent = recentLabel(run.createdAt)
  const href = run.phase === 'ready' && run.artifactId ? `/artifacts/${run.artifactId}` : null
  const openable = Boolean(onOpenRun && run.phase === 'ready' && run.artifactId)
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            <time dateTime={run.createdAt}>{absoluteDate(run.createdAt)}</time>
            {recent && <span className="font-normal text-muted-foreground"> · {recent}</span>}
          </p>
          <p className={cn('mt-0.5 text-sm', run.reason ? 'text-foreground' : 'text-muted-foreground')}>{run.reason || 'No reason recorded'}</p>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <span className={badgeVariants({ variant: status.tone })}>{status.label}</span>
          {href && <ArrowUpRight className="h-4 w-4 text-muted-foreground group-hover:text-horizon-700" aria-hidden />}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {run.configSummary.map((line, index) => (
          <span key={`${index}:${line}`} className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">{line}</span>
        ))}
        {run.requestedBy && <span className="ml-auto text-xs text-muted-foreground">Run by {run.requestedBy}</span>}
      </div>
      {run.phase === 'failed' && run.error && <p className="mt-1.5 text-xs text-red-700">{run.error}</p>}
    </>
  )
  return (
    <li>
      {openable ? (
        <button type="button" onClick={() => onOpenRun?.(run)} className="group block w-full px-3 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
          <span className="sr-only">Show this version of the report: </span>
          {body}
        </button>
      ) : href ? (
        <Link href={href} className="group block px-3 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4">
          <span className="sr-only">Open the report: </span>
          {body}
        </Link>
      ) : (
        <div className="px-3 py-3 sm:px-4">{body}</div>
      )}
    </li>
  )
}

function RunComparison({ account, runs, onOpenRun }: { account: string; runs: RoiAnalysisView[]; onOpenRun?: OpenRun }) {
  const comparison = useMemo(() => compareRuns(runs), [runs])
  return (
    <div className="border-b bg-muted/20 px-3 py-3 sm:px-4">
      <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Run over run</p>
      {comparison.rows.length === 0 ? (
        <p className="mt-1.5 text-sm text-muted-foreground">These runs recorded no headline numbers to compare.</p>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-lg border bg-background">
          <table className="w-full min-w-max text-sm">
            <caption className="sr-only">Headline numbers for {account}, one column per completed run, oldest first</caption>
            <thead className="bg-muted/40">
              <tr>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Measure</th>
                {comparison.runs.map((run) => (
                  <th key={run.id} scope="col" className="px-3 py-2 text-right align-bottom text-xs font-medium">
                    {run.artifactId && onOpenRun ? (
                      <button type="button" onClick={() => { const full = runs.find((candidate) => candidate.id === run.id); if (full) onOpenRun(full) }} className="text-horizon-700 hover:underline">{absoluteDate(run.createdAt, false)}</button>
                    ) : run.artifactId ? (
                      <Link href={`/artifacts/${run.artifactId}`} className="text-horizon-700 hover:underline">{absoluteDate(run.createdAt, false)}</Link>
                    ) : absoluteDate(run.createdAt, false)}
                    {run.reason && <span className="block max-w-[11rem] truncate font-normal text-muted-foreground" title={run.reason}>{run.reason}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((row) => (
                <tr key={row.key} className="border-t">
                  <th scope="row" className="px-3 py-2 text-left font-normal">{row.label}</th>
                  {row.cells.map((cell, index) => (
                    <td key={comparison.runs[index].id} className="px-3 py-2 text-right font-mono tabular-nums">
                      {cell ?? <><span aria-hidden className="text-muted-foreground">—</span><span className="sr-only">Not recorded</span></>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
