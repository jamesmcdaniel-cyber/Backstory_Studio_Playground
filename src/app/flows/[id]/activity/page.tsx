'use client'

import { Fragment, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ChevronRight, RefreshCw, ScrollText } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { FlowGraph } from '@/lib/flows/graph'
import { cn } from '@/lib/utils'

type RunStepSummary = { nodeId: string; status: string; order: number; error?: string | null }
type RunWaiting = { nodeId: string; kind: 'input' | 'approval'; question?: string }
type RunSummary = {
  id: string
  status: string
  startedAt: string
  finishedAt: string | null
  trigger?: { type?: string; [key: string]: unknown } | null
  error?: string | null
  waiting?: RunWaiting | null
  steps: RunStepSummary[]
}

type StatusFilter = 'all' | 'running' | 'succeeded' | 'failed' | 'waiting'

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'succeeded', label: 'Succeeded' },
  { key: 'failed', label: 'Failed' },
  { key: 'waiting', label: 'Waiting' },
]

const STATUS_BADGE: Record<string, 'good' | 'risk' | 'warn' | 'info' | 'outline'> = {
  succeeded: 'good',
  failed: 'risk',
  running: 'info',
  waiting: 'warn',
}

const STEP_DOT: Record<string, string> = {
  succeeded: 'bg-emerald-500',
  failed: 'bg-red-500',
  waiting: 'bg-blue-500',
  running: 'bg-amber-500',
  skipped: 'bg-gray-300',
  queued: 'bg-gray-300',
  resumed: 'bg-gray-300',
}

const STEP_TEXT: Record<string, string> = {
  succeeded: 'text-emerald-600',
  failed: 'text-red-600',
  waiting: 'text-blue-600',
  running: 'text-amber-600',
  skipped: 'text-gray-400',
  queued: 'text-gray-400',
  resumed: 'text-gray-400',
}

/** Node label for a run step: the agent's own label, else the step type,
 *  title-cased. Falls back to the raw id while the flow graph hasn't loaded. */
function labelForNode(graph: FlowGraph | null, nodeId: string): string {
  const node = graph?.nodes.find((n) => n.id === nodeId)
  if (!node) return nodeId
  if (node.type === 'agent') return node.data.label || 'Agent step'
  return node.type.charAt(0).toUpperCase() + node.type.slice(1)
}

function duration(run: RunSummary): string {
  if (!run.finishedAt) return '—'
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function triggerLabel(run: RunSummary): string {
  const type = run.trigger?.type || 'manual'
  return type.charAt(0).toUpperCase() + type.slice(1)
}

/** Blue banner shown under a paused run's row — carries the reply box for agent
 *  questions. Mirrors the builder Runs panel's WaitingBanner (not exported there). */
function WaitingBanner({
  waiting,
  runId,
  onReply,
}: {
  waiting: RunWaiting
  runId: string
  onReply: (flowRunId: string, reply: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const submit = async () => {
    const reply = text.trim()
    if (!reply || sending) return
    setSending(true)
    try {
      await onReply(runId, reply)
      setText('')
    } catch {
      // The page already surfaced the error — keep the text for a retry.
    } finally {
      setSending(false)
    }
  }
  return (
    <div className="rounded-md border border-blue-200 bg-blue-50 p-3 dark:border-blue-900/40 dark:bg-blue-950/40">
      {waiting.kind === 'approval' ? (
        <>
          <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">Waiting for an approval decision</p>
          <p className="mt-1 text-xs text-blue-800 dark:text-blue-300">A step needs an approval before this run can continue.</p>
        </>
      ) : (
        <>
          <p className="text-sm font-semibold text-blue-900 dark:text-blue-200">Waiting for your reply</p>
          {/* Neutral fallback: input pauses come from agent questions AND humanReview steps. */}
          <p className="mt-1 text-xs text-blue-800 dark:text-blue-300">{waiting.question || 'This flow is waiting on information from you.'}</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="Type your reply…"
            disabled={sending}
            className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-blue-300 dark:focus:border-blue-800"
          />
          <div className="mt-2 flex justify-end">
            <Button size="sm" onClick={submit} loading={sending} disabled={!text.trim() || sending}>
              Send reply
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

export default function FlowActivityPage() {
  const { id } = useParams<{ id: string }>()
  const [flowName, setFlowName] = useState('')
  const [graph, setGraph] = useState<FlowGraph | null>(null)
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [triggerFilter, setTriggerFilter] = useState<string>('all')
  const [fromDate, setFromDate] = useState<string>('')
  const [toDate, setToDate] = useState<string>('')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // Flow name + graph (for step labels) — same loader shape as the builder.
  useEffect(() => {
    let cancelled = false
    fetch('/api/flows', { cache: 'no-store' })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return
        const flow = (data.flows || []).find((f: { id: string }) => f.id === id)
        if (flow) {
          setFlowName(flow.name)
          setGraph(flow.graph && flow.graph.nodes ? flow.graph : null)
        }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [id])

  // Runs table — refetches on filter change or Refresh, and self-polls every
  // 5s while any visible run is still running/waiting (stopping once settled).
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const load = async () => {
      const qs = new URLSearchParams({ summary: '1' })
      if (filter !== 'all') qs.set('status', filter)
      const data = await fetch(`/api/flows/${id}/runs?${qs.toString()}`, { cache: 'no-store' })
        .then((response) => response.json())
        .catch(() => null)
      if (cancelled) return
      const nextRuns: RunSummary[] = data?.success ? data.runs : []
      setRuns(nextRuns)
      setLoading(false)
      const active = nextRuns.some((run) => run.status === 'running' || run.status === 'waiting')
      if (active && !timer) timer = setInterval(load, 5000)
      if (!active && timer) {
        clearInterval(timer)
        timer = null
      }
    }
    setLoading(true)
    load()
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [id, filter, refreshKey])

  // Resume a paused run with the user's reply, then refetch (keeps the filter).
  const replyToRun = async (flowRunId: string, reply: string) => {
    const response = await fetch(`/api/flows/${id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowRunId, reply }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      toast.error(data.error || 'Could not send the reply.')
      // Re-throw so the banner keeps the typed reply for a retry.
      throw new Error(data.error || 'Could not send the reply.')
    }
    toast.success('Reply sent — resuming the flow.')
    setRefreshKey((k) => k + 1)
  }

  // Trigger + date filters run client-side over the loaded runs (status is
  // server-filtered above). Keeps the filter set rich without an API change.
  const visibleRuns = runs.filter((run) => {
    if (triggerFilter !== 'all' && (run.trigger?.type || 'manual') !== triggerFilter) return false
    const started = new Date(run.startedAt).getTime()
    if (fromDate && started < new Date(fromDate).getTime()) return false
    if (toDate && started > new Date(toDate).getTime() + 86_400_000) return false // inclusive end-of-day
    return true
  })

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeader eyebrow={flowName || 'Flow'} title="Activity" description="Run history for this flow — filter, inspect steps, and watch live runs." />
        <div className="flex items-center gap-2">
          <Link href={`/flows/${id}`} className="text-sm font-medium text-primary hover:underline">
            Back to builder
          </Link>
          <Button variant="outline" size="sm" onClick={() => setRefreshKey((k) => k + 1)} disabled={loading}>
            <RefreshCw className={cn('mr-1.5 h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((entry) => (
          <Button
            key={entry.key}
            variant={filter === entry.key ? 'default' : 'outline'}
            size="sm"
            onClick={() => setFilter(entry.key)}
          >
            {entry.label}
          </Button>
        ))}
        <span className="mx-1 h-5 w-px bg-border" />
        <Select value={triggerFilter} onValueChange={setTriggerFilter}>
          <SelectTrigger className="h-9 w-[150px]" aria-label="Filter by trigger">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All triggers</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="schedule">Schedule</SelectItem>
            <SelectItem value="poll">Poll</SelectItem>
            <SelectItem value="webhook">Webhook</SelectItem>
            <SelectItem value="signal">Signal</SelectItem>
          </SelectContent>
        </Select>
        <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="h-9 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-indigo-400" aria-label="From date" />
        <span className="text-xs text-muted-foreground">to</span>
        <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="h-9 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-indigo-400" aria-label="To date" />
        {(triggerFilter !== 'all' || fromDate || toDate) && (
          <Button variant="ghost" size="sm" onClick={() => { setTriggerFilter('all'); setFromDate(''); setToDate('') }}>
            Clear
          </Button>
        )}
      </div>

      {loading && runs.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      ) : visibleRuns.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="No matching runs"
          description={filter === 'all' && triggerFilter === 'all' && !fromDate && !toDate ? 'Run this flow to see its history here.' : 'No runs match the current filters.'}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Error</TableHead>
              <TableHead>
                <span className="sr-only">Open in builder</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleRuns.map((run) => {
              const expanded = expandedId === run.id
              return (
                <Fragment key={run.id}>
                  <TableRow className="cursor-pointer" onClick={() => setExpandedId(expanded ? null : run.id)}>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
                        <Badge variant={STATUS_BADGE[run.status] || 'outline'} className="capitalize">
                          {run.status}
                        </Badge>
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{new Date(run.startedAt).toLocaleString()}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{duration(run)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{triggerLabel(run)}</TableCell>
                    <TableCell className="max-w-xs truncate text-sm text-red-600">{run.error || ''}</TableCell>
                    <TableCell className="text-right">
                      <Link
                        href={`/flows/${id}?run=${run.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="whitespace-nowrap text-xs font-medium text-primary hover:underline"
                      >
                        Open in builder
                      </Link>
                    </TableCell>
                  </TableRow>
                  {run.status === 'waiting' && run.waiting && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="pt-0">
                        <WaitingBanner key={run.id} waiting={run.waiting} runId={run.id} onReply={replyToRun} />
                      </TableCell>
                    </TableRow>
                  )}
                  {expanded && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="bg-muted/30 p-0">
                        {run.steps.length === 0 ? (
                          <p className="px-6 py-3 text-sm text-muted-foreground">This run ended before any step executed.</p>
                        ) : (
                          <div className="divide-y divide-border/60 px-2 py-2">
                            {run.steps.map((step, i) => {
                              // The paused step reads as what it needs, never the bare status word.
                              const waitingKind = step.status === 'waiting' && run.waiting?.nodeId === step.nodeId ? run.waiting.kind : undefined
                              const statusLabel = waitingKind ? (waitingKind === 'input' ? 'Waiting for your reply' : 'Waiting for approval') : step.status
                              return (
                                <div key={`${step.nodeId}-${i}`} className="flex items-center gap-2 px-4 py-1.5">
                                  <span className={cn('h-2 w-2 shrink-0 rounded-full', STEP_DOT[step.status] || 'bg-gray-300')} />
                                  <span className="flex-1 truncate text-sm">{labelForNode(graph, step.nodeId)}</span>
                                  <span className={cn('text-xs font-medium', !waitingKind && 'capitalize', STEP_TEXT[step.status] || 'text-muted-foreground')}>{statusLabel}</span>
                                  {step.error && <span className="max-w-xs truncate text-xs text-red-600">{step.error}</span>}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
