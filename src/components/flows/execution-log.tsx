'use client'

import { Fragment, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ChevronRight, RefreshCw, ScrollText, Workflow } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Pagination } from '@/components/ui/pagination'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { STATUS_DOT, STATUS_TEXT } from '@/lib/flows/node-presentation'
import {
  executionDuration,
  executionFailureSummary,
  executionIsDegraded,
  executionTriggerLabel,
  type ExecutionLogStep,
} from '@/lib/flows/execution-log'
import { cn } from '@/lib/utils'

type FlowExecution = {
  id: string
  status: string
  startedAt: string
  finishedAt: string | null
  trigger?: { type?: string; [key: string]: unknown } | null
  error?: string | null
  flow: { id: string; name: string; icon?: string }
  steps: ExecutionLogStep[]
  /** Persisted at finalize (execute-flow.ts) from the FULL step set. Absent on
   *  pre-migration rows / older cached payloads — only then does
   *  executionIsDegraded fall back to inferring over `steps`. */
  degraded?: boolean
}

type StatusFilter = 'all' | 'running' | 'succeeded' | 'failed' | 'waiting' | 'cancelled'

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'succeeded', label: 'Succeeded' },
  { key: 'failed', label: 'Failed' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'cancelled', label: 'Cancelled' },
]

const STATUS_BADGE: Record<string, 'good' | 'risk' | 'warn' | 'info' | 'outline'> = {
  succeeded: 'good',
  failed: 'risk',
  running: 'info',
  waiting: 'warn',
  cancelling: 'warn',
  cancelled: 'outline',
}

export function FlowExecutionLog() {
  const [runs, setRuns] = useState<FlowExecution[]>([])
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [page, setPage] = useState(1)
  const [pageCount, setPageCount] = useState(1)
  const [total, setTotal] = useState(0)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    const load = async () => {
      const query = new URLSearchParams({ page: String(page), take: '20' })
      if (filter !== 'all') query.set('status', filter)
      const response = await fetch(`/api/flows/runs?${query.toString()}`, { cache: 'no-store' }).catch(() => null)
      const data = response?.ok ? await response.json().catch(() => null) : null
      if (cancelled) return
      if (!data?.success) {
        setLoadError(true)
        setLoading(false)
        return
      }
      const nextRuns: FlowExecution[] = data.runs
      setRuns(nextRuns)
      setTotal(data.total)
      setPageCount(data.pageCount)
      setLoadError(false)
      setLoading(false)

      const active = nextRuns.some((run) => run.status === 'running' || run.status === 'waiting' || run.status === 'cancelling')
      if (active && !timer) timer = setInterval(load, 5000)
      if (!active && timer) {
        clearInterval(timer)
        timer = null
      }
    }

    setLoading(true)
    void load()
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [filter, page, refreshKey])

  return (
    <section className="space-y-4" aria-labelledby="flow-execution-log-title">
      <Card variant="flat" className="border-border/70">
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle id="flow-execution-log-title" className="flex items-center gap-2 text-lg">
              <ScrollText className="h-5 w-5 text-indigo-500" /> Execution log
            </CardTitle>
            <CardDescription className="mt-1">
              Successes and failures across every flow in this workspace. Expand a run to see the step that caused it.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRefreshKey((key) => key + 1)}
            disabled={loading}
          >
            <RefreshCw className={cn('mr-1.5 h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
        </CardHeader>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((entry) => (
          <Button
            key={entry.key}
            variant={filter === entry.key ? 'default' : 'outline'}
            size="sm"
            onClick={() => { setFilter(entry.key); setPage(1); setExpandedId(null) }}
          >
            {entry.label}
          </Button>
        ))}
        {!loading && !loadError && (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {total} run{total === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {loading && runs.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-12 rounded-lg" />)}
        </div>
      ) : loadError ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-center dark:border-red-900/40 dark:bg-red-950/30">
          <AlertTriangle className="mx-auto h-5 w-5 text-red-600" />
          <p className="mt-2 text-sm font-medium text-red-900 dark:text-red-200">Could not load the execution log.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => setRefreshKey((key) => key + 1)}>Try again</Button>
        </div>
      ) : runs.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={filter === 'all' ? 'No flow runs yet' : `No ${filter} runs`}
          description={filter === 'all' ? 'Run a flow to see its status and diagnostic details here.' : 'No runs match this status filter.'}
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Flow</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Diagnostic</TableHead>
                <TableHead><span className="sr-only">Run details</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => {
                const expanded = expandedId === run.id
                const summary = executionFailureSummary(run)
                return (
                  <Fragment key={run.id}>
                    <TableRow className="cursor-pointer" onClick={() => setExpandedId(expanded ? null : run.id)}>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />
                          <Badge variant={STATUS_BADGE[run.status] || 'outline'} className="capitalize">{run.status}</Badge>
                          {executionIsDegraded(run) && (
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500" title="Succeeded with warnings" />
                          )}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex min-w-36 items-center gap-2 font-medium">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-indigo-50 text-sm text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300">
                            {run.flow.icon || <Workflow className="h-3.5 w-3.5" />}
                          </span>
                          <span className="max-w-52 truncate">{run.flow.name}</span>
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(run.startedAt).toLocaleString()}</TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground">{executionDuration(run)}</TableCell>
                      <TableCell className="text-muted-foreground">{executionTriggerLabel(run.trigger)}</TableCell>
                      <TableCell className={cn('max-w-xs truncate', summary && (run.status === 'failed' ? 'text-red-600' : 'text-amber-700 dark:text-amber-400'))} title={summary}>
                        {summary || '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          href={`/flows/${run.flow.id}?run=${run.id}`}
                          onClick={(event) => event.stopPropagation()}
                          className="whitespace-nowrap text-xs font-medium text-primary hover:underline"
                        >
                          Full details
                        </Link>
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={7} className="bg-muted/30 p-0">
                          {run.error && (
                            <div className="m-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
                              <span className="font-semibold">Run error:</span> {run.error}
                            </div>
                          )}
                          {run.steps.length === 0 ? (
                            <p className="px-6 py-4 text-sm text-muted-foreground">This run ended before any step was recorded.</p>
                          ) : (
                            <div className="divide-y divide-border/60 px-3 py-2">
                              {run.steps.map((step, index) => (
                                <div key={`${step.nodeId}-${index}`} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
                                  <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', STATUS_DOT[step.status as keyof typeof STATUS_DOT] || 'bg-gray-300')} />
                                  <span className="min-w-40 flex-1 text-sm font-medium">{step.label || step.nodeId}</span>
                                  <span className={cn('text-xs font-medium capitalize', STATUS_TEXT[step.status as keyof typeof STATUS_TEXT] || 'text-muted-foreground')}>{step.status}</span>
                                  {(step.error || (step.warnings?.length ?? 0) > 0) && (
                                    <div className="basis-full pl-5 text-xs">
                                      {step.error && <p className="text-red-600 dark:text-red-400">{step.error}</p>}
                                      {step.warnings?.map((warning, warningIndex) => (
                                        <p key={warningIndex} className="text-amber-700 dark:text-amber-400">Warning: {warning}</p>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
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
          <Pagination page={page} pageCount={pageCount} onPageChange={(nextPage) => { setPage(nextPage); setExpandedId(null) }} />
        </>
      )}
    </section>
  )
}
