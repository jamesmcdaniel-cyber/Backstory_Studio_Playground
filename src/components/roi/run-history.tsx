'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, ChevronRight, Columns3, Folder, FolderOpen, History, Loader2, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { badgeVariants } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { SegmentedControl } from '@/components/roi/panel-section'
import { relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { compareRuns, groupRunsByAccount, isRunSettled, runStatus, runsSummary, type RoiAccountFolder, type RoiRunStatus } from '@/lib/roi/history'
import type { RoiAnalysisView } from '@/lib/roi/types'

/** How many of a folder's runs the compact list shows before "Show all". */
const COMPACT_RUNS = 6

const STATUS_TEXT: Record<RoiRunStatus['tone'], string> = {
  good: 'text-[var(--status-good-fg)]',
  risk: 'text-[var(--status-risk-fg)]',
  info: 'text-horizon-700',
}
const STATUS_DOT: Record<RoiRunStatus['tone'], string> = {
  good: 'bg-[var(--status-good-fg)]',
  risk: 'bg-[var(--status-risk-fg)]',
  info: 'bg-horizon-500',
}

function folderKey(account: string): string {
  return account.trim().toLowerCase()
}

/** A DOM id for an account: readable, plus a short hash so names that slug alike ("日本", "中国") stay distinct. */
function domId(prefix: string, key: string): string {
  let hash = 5381
  for (let index = 0; index < key.length; index += 1) hash = ((hash * 33) ^ key.charCodeAt(index)) >>> 0
  return `${prefix}-${key.replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${hash.toString(36)}`
}

function absoluteDate(iso: string, withTime = true): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleString(undefined, withTime ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "Oct 7, 3:12 PM" this year; "Oct 7, 2025" before it. */
function shortDate(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  return date.getFullYear() === new Date().getFullYear()
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** "2h ago" while it says more than the date does; nothing once relativeTime falls back to a date. */
function recentLabel(iso: string): string | null {
  const relative = relativeTime(iso)
  return relative === 'just now' || relative.endsWith('ago') ? relative : null
}

/** Opens a finished run's version of the report in place (the ROI page); without it, runs link to their artifact. */
type OpenRun = (run: RoiAnalysisView) => void

type RunHistoryProps = {
  analyses: RoiAnalysisView[] | null
  error?: string | null
  onOpenRun?: OpenRun
  /** The side panel's variant: the selected account's runs first, compact rows, opened in place. */
  compact?: boolean
  /** The account the panel shows (compact): its runs are listed until "All accounts" is chosen. */
  selectedAccount?: string
}

/**
 * Every analysis run from the page, in one folder per account (the most
 * recently run first). A completed run opens its report; an account with two
 * or more completed runs can put their headline numbers side by side.
 *
 * Compact (the side panel): the selected account's runs, with a switch to
 * every account's. A row opens in place when the run produced a version of
 * the viewer's own page; other rows are a record only.
 */
export function RunHistory(props: RunHistoryProps) {
  return props.compact ? <CompactRunHistory {...props} /> : <FullRunHistory {...props} />
}

function FullRunHistory({ analyses, error, onOpenRun }: RunHistoryProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [comparing, setComparing] = useState<Record<string, boolean>>({})
  const folders = useMemo(() => groupRunsByAccount(analyses ?? [], query), [analyses, query])
  const searching = Boolean(query.trim())

  return (
    <section aria-labelledby="roi-history-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="roi-history-heading" className="text-lg font-semibold tracking-tight">Run history</h2>
          <p className="text-sm text-muted-foreground">Every run, by account: settings changes and data refreshes. Open one to see that version.</p>
        </div>
        {analyses && analyses.length > 0 && (
          <div className="relative w-full sm:w-64">
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
  const panelId = domId('roi-folder', folderKey(folder.account))
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
          <span className="min-w-[3rem] truncate font-medium" title={folder.account}>{folder.account}</span>
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

function CompactRunHistory({ analyses, error, onOpenRun, selectedAccount }: RunHistoryProps) {
  const selectedKey = selectedAccount ? folderKey(selectedAccount) : ''
  const [scope, setScope] = useState<'account' | 'all'>('account')
  const [query, setQuery] = useState('')
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({})
  const [comparing, setComparing] = useState<Record<string, boolean>>({})
  const folders = useMemo(() => groupRunsByAccount(analyses ?? []), [analyses])
  const matching = useMemo(() => groupRunsByAccount(analyses ?? [], query), [analyses, query])
  const own = selectedKey ? folders.find((folder) => folderKey(folder.account) === selectedKey) ?? null : null
  const showAll = !selectedKey || scope === 'all'
  const searching = Boolean(query.trim())
  const toggleCompare = (key: string) => setComparing((current) => ({ ...current, [key]: !current[key] }))

  if (analyses === null) {
    return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading the run history…</p>
  }
  return (
    <div className="space-y-2.5">
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {analyses.length === 0 ? (
        <p className="text-xs text-muted-foreground">No runs yet. Settings changes and data refreshes from this page appear here.</p>
      ) : (
        <>
          {selectedKey && (
            <SegmentedControl
              name="roi-history-scope"
              label="Runs to show"
              value={scope}
              onChange={setScope}
              options={[{ value: 'account', label: 'This account' }, { value: 'all', label: 'All accounts' }]}
            />
          )}
          {!showAll ? (
            own ? (
              <FolderRuns folder={own} comparing={Boolean(comparing[selectedKey])} onToggleCompare={() => toggleCompare(selectedKey)} onOpenRun={onOpenRun} />
            ) : (
              <p className="text-xs text-muted-foreground">No runs for {selectedAccount} yet.</p>
            )
          ) : (
            <div className="space-y-2">
              {folders.length > 1 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden />
                  <label htmlFor="roi-history-search" className="sr-only">Search accounts</label>
                  <Input id="roi-history-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search accounts" className="h-8 pl-8 text-xs" />
                </div>
              )}
              {matching.length === 0 ? (
                <p className="text-xs text-muted-foreground">No account matches “{query.trim()}”.</p>
              ) : (
                <ul className="divide-y divide-border overflow-hidden rounded-lg border">
                  {matching.map((folder) => {
                    const key = folderKey(folder.account)
                    const isOpen = openFolders[key] ?? (searching && matching.length === 1)
                    return (
                      <li key={key}>
                        <CompactFolder
                          folder={folder}
                          isOpen={isOpen}
                          onToggle={() => setOpenFolders((current) => ({ ...current, [key]: !isOpen }))}
                          comparing={Boolean(comparing[key])}
                          onToggleCompare={() => toggleCompare(key)}
                          onOpenRun={onOpenRun}
                        />
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** An account in the compact "All accounts" list: its full name on its own line, never squeezed by controls. */
function CompactFolder({ folder, isOpen, onToggle, comparing, onToggleCompare, onOpenRun }: {
  folder: RoiAccountFolder
  isOpen: boolean
  onToggle: () => void
  comparing: boolean
  onToggleCompare: () => void
  onOpenRun?: OpenRun
}) {
  const bodyId = domId('roi-history-folder', folderKey(folder.account))
  const FolderIcon = isOpen ? FolderOpen : Folder
  return (
    <div>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-fast hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-fast', isOpen && 'rotate-90')} aria-hidden />
        <FolderIcon className="h-4 w-4 shrink-0 text-horizon-600" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={folder.account}>{folder.account}</span>
          <span className="block text-[11px] text-muted-foreground">{runsSummary(folder.runs)}</span>
        </span>
      </button>
      <div id={bodyId} hidden={!isOpen} className="border-t bg-muted/20 px-3 py-2">
        <FolderRuns folder={folder} comparing={comparing} onToggleCompare={onToggleCompare} onOpenRun={onOpenRun} />
      </div>
    </div>
  )
}

/** One account's runs, compact: a hint and Compare runs above, the newest few rows, "Show all" for the rest. */
function FolderRuns({ folder, comparing, onToggleCompare, onOpenRun }: {
  folder: RoiAccountFolder
  comparing: boolean
  onToggleCompare: () => void
  onOpenRun?: OpenRun
}) {
  const [expanded, setExpanded] = useState(false)
  const listId = domId('roi-history-runs', folderKey(folder.account))
  const canCompare = folder.completed >= 2
  const isComparing = canCompare && comparing
  const anyOpenable = Boolean(onOpenRun) && folder.runs.some((run) => run.pageVersionId)
  const runs = expanded ? folder.runs : folder.runs.slice(0, COMPACT_RUNS)
  return (
    <div className="space-y-1.5">
      {(anyOpenable || canCompare) && (
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 text-[11px] text-muted-foreground">{anyOpenable ? 'Select a run to show it on your page.' : ''}</p>
          {canCompare && (
            <button
              type="button"
              aria-pressed={isComparing}
              onClick={onToggleCompare}
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-horizon-700 transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isComparing ? 'bg-horizon-50 ring-1 ring-inset ring-horizon-200' : 'hover:bg-horizon-50',
              )}
            >
              <Columns3 className="h-3.5 w-3.5" aria-hidden />Compare runs
            </button>
          )}
        </div>
      )}
      {isComparing && <RunComparison account={folder.account} runs={folder.runs} onOpenRun={onOpenRun} compact />}
      <ul id={listId} className="-mx-1.5">
        {runs.map((run) => <CompactRunRow key={run.id} run={run} onOpenRun={onOpenRun} />)}
      </ul>
      {folder.runs.length > COMPACT_RUNS && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
          className="rounded text-xs font-medium text-horizon-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? 'Show fewer' : `Show all ${folder.runs.length} runs`}
        </button>
      )}
    </div>
  )
}

/** A run in two lines: date · reason · status, then its settings. Opens in place when it is a version of the viewer's page. */
function CompactRunRow({ run, onOpenRun }: { run: RoiAnalysisView; onOpenRun?: OpenRun }) {
  const status = runStatus(run.phase)
  const openable = Boolean(onOpenRun && run.pageVersionId)
  const reason = run.reason || 'No reason recorded'
  const settings = run.configSummary.join(' · ')
  const when = [absoluteDate(run.createdAt), run.requestedBy ? `run by ${run.requestedBy}` : null].filter(Boolean).join(' · ')
  const body = (
    <>
      <span className="flex items-center gap-1.5 text-xs">
        <time dateTime={run.createdAt} title={when} className="shrink-0 font-medium tabular-nums text-foreground">{shortDate(run.createdAt)}</time>
        <span aria-hidden className="text-muted-foreground">·</span>
        <span className={cn('min-w-0 flex-1 truncate', run.reason ? 'text-foreground' : 'text-muted-foreground')} title={reason}>{reason}</span>
        <span className={cn('inline-flex shrink-0 items-center gap-1 text-[11px] font-medium', STATUS_TEXT[status.tone])}>
          <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[status.tone], !isRunSettled(run.phase) && 'animate-pulse motion-reduce:animate-none')} />
          {status.label}
        </span>
      </span>
      {settings && <span className="mt-0.5 block truncate text-[11px] text-muted-foreground" title={settings}>{settings}</span>}
      {run.phase === 'failed' && run.error && <span className="mt-0.5 line-clamp-2 break-words text-[11px] text-red-700" title={run.error}>{run.error}</span>}
    </>
  )
  return (
    <li>
      {openable ? (
        <button
          type="button"
          onClick={() => onOpenRun?.(run)}
          className="block w-full rounded-md px-1.5 py-1.5 text-left transition-colors duration-fast hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="sr-only">Show this version on your page: </span>
          {body}
        </button>
      ) : (
        <div className="px-1.5 py-1.5">{body}</div>
      )}
    </li>
  )
}

function RunComparison({ account, runs, onOpenRun, compact = false }: { account: string; runs: RoiAnalysisView[]; onOpenRun?: OpenRun; compact?: boolean }) {
  const comparison = useMemo(() => compareRuns(runs), [runs])
  const cell = compact ? 'px-2 py-1.5' : 'px-3 py-2'
  return (
    <div className={compact ? '' : 'border-b bg-muted/20 px-3 py-3 sm:px-4'}>
      {!compact && <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">Run over run</p>}
      {comparison.rows.length === 0 ? (
        <p className={cn('text-muted-foreground', compact ? 'text-xs' : 'mt-1.5 text-sm')}>These runs recorded no headline numbers to compare.</p>
      ) : (
        <div className={cn('overflow-x-auto rounded-lg border bg-background', !compact && 'mt-2')}>
          <table className={cn('w-full min-w-max', compact ? 'text-xs' : 'text-sm')}>
            <caption className="sr-only">Headline numbers for {account}, one column per completed run, oldest first</caption>
            <thead className="bg-muted/40">
              <tr>
                <th scope="col" className={cn(cell, 'text-left text-xs font-medium text-muted-foreground')}>Measure</th>
                {comparison.runs.map((run) => {
                  const full = runs.find((candidate) => candidate.id === run.id)
                  const date = absoluteDate(run.createdAt, false)
                  // Compact: a column opens only as a version of the viewer's page.
                  const opener = onOpenRun
                  const open = full && opener && (compact ? full.pageVersionId : run.artifactId) ? () => opener(full) : null
                  return (
                    <th key={run.id} scope="col" className={cn(cell, 'text-right align-bottom text-xs font-medium')}>
                      {open ? (
                        <button type="button" onClick={open} className="rounded text-horizon-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{date}</button>
                      ) : !compact && run.artifactId ? (
                        <Link href={`/artifacts/${run.artifactId}`} className="text-horizon-700 hover:underline">{date}</Link>
                      ) : date}
                      {run.reason && <span className={cn('block truncate font-normal text-muted-foreground', compact ? 'max-w-[8rem]' : 'max-w-[11rem]')} title={run.reason}>{run.reason}</span>}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {comparison.rows.map((row) => (
                <tr key={row.key} className="border-t">
                  <th scope="row" className={cn(cell, 'text-left font-normal')}>{row.label}</th>
                  {row.cells.map((value, index) => (
                    <td key={comparison.runs[index].id} className={cn(cell, 'text-right font-mono tabular-nums')}>
                      {value ?? <><span aria-hidden className="text-muted-foreground">—</span><span className="sr-only">Not recorded</span></>}
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
