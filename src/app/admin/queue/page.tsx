'use client'

/**
 * Operator queue console — where the "Queue plane needs attention" alert
 * (src/lib/queue/queue-watch.ts) lands.
 *
 * That alert used to link at `/admin`, a segment with a layout and four child
 * routes but no page of its own, so every click on a dead-letter notification
 * reached Next's 404 instead of the backlog it was reporting. The runbook path
 * (`npm run queue:dlq`, docs/runbooks/queue-incident.md) needs production
 * REDIS_URL in a terminal; this page is the same read over the operator API,
 * for the person who just clicked the alert on their phone.
 *
 * Read-first: the table answers "what failed and why" without touching
 * anything. Replay and drop are both genuinely destructive (a replay re-runs a
 * job with external side effects; a drop discards the only durable record of a
 * failure), so they sit behind an explicit confirm — the same rule the CLI
 * enforces with --confirm and the API with `confirm: true`.
 *
 * The client checks no permission: /api/admin/queue/dead-letters re-checks
 * platform.administer and internal-edition on every call, so a hand-typed URL
 * gains an empty table, not another workspace's job payloads.
 */

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type DeadLetterSummary = {
  id: string
  dlq: string
  queue: string | null
  jobName: string | null
  executionId: string | null
  flowRunId: string | null
  organizationId: string | null
  failedReason: string | null
  timestamps: { enqueuedAt: string | null; processedAt: string | null; finishedAt: string | null }
  payloadSummary: string
  replayable: boolean
}

type DeadLetterDetail = DeadLetterSummary & { payload: unknown; attemptsMade: number }

type Listing = {
  counts: { total: number; queues: { queue: string; waiting: number }[] }
  deadLetters: DeadLetterSummary[]
}

const when = (value: string | null) => (value ? new Date(value).toLocaleString() : '—')

/** `flow-dead-letter` reads as "Flow" in a column that already says dead letter. */
const dlqLabel = (dlq: string) => dlq.replace(/-dead-letter$/, '').replace(/-/g, ' ')

export default function QueueAdminPage() {
  const [listing, setListing] = useState<Listing | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<DeadLetterDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const response = await fetch('/api/admin/queue/dead-letters?limit=100', { cache: 'no-store' })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.success) {
      // Redis unreachable is the common failure here, and it matters: an empty
      // table would otherwise read as "all clear" during exactly the incident
      // this page exists for.
      setLoadError(body?.error ?? `Could not read the dead-letter queues (HTTP ${response.status}).`)
      setListing(null)
    } else {
      setLoadError(null)
      setListing({ counts: body.counts, deadLetters: body.deadLetters })
      setSelectedId((current) =>
        current && body.deadLetters.some((row: DeadLetterSummary) => row.id === current) ? current : null,
      )
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let cancelled = false
    void (async () => {
      const response = await fetch(`/api/admin/queue/dead-letters?id=${encodeURIComponent(selectedId)}`, {
        cache: 'no-store',
      })
      const body = await response.json().catch(() => null)
      if (cancelled) return
      if (!response.ok || !body?.success) {
        toast.error(body?.error ?? 'Could not open that dead letter.')
        setDetail(null)
        return
      }
      setDetail(body.deadLetter as DeadLetterDetail)
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId])

  const act = async (action: 'replay' | 'drop', row: DeadLetterSummary) => {
    const prompt =
      action === 'replay'
        ? `Re-enqueue ${row.id} onto ${row.queue}? It runs again with real side effects — prefer re-running the flow or agent from the app when you can.`
        : `Drop ${row.id}? This discards the only durable record of that failure.`
    if (!confirm(prompt)) return
    setBusy(true)
    const response = await fetch('/api/admin/queue/dead-letters', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, id: row.id, confirm: true }),
    })
    const body = await response.json().catch(() => null)
    setBusy(false)
    if (!response.ok || !body?.success) {
      toast.error(body?.error ?? 'That did not work.')
      return
    }
    toast.success(action === 'replay' ? `Replayed onto ${body.replayed?.queue ?? row.queue}.` : 'Dropped.')
    setSelectedId(null)
    await load()
  }

  const total = listing?.counts.total ?? 0

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Queue plane</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Jobs that exhausted their attempts and were parked instead of lost. Agent and flow jobs are never
            auto-retried — they have external side effects — so each one waits here until an operator decides. The
            owning run was already marked failed.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={cn('mr-2 h-4 w-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      </header>

      {loadError && (
        <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          {loadError}
        </p>
      )}

      {listing && (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <span className="text-3xl font-semibold tabular-nums">{total}</span>
          <span className="text-sm text-muted-foreground">
            {total === 1 ? 'job parked' : 'jobs parked'} across {listing.counts.queues.length} dead-letter queues
          </span>
          <div className="flex flex-wrap gap-2">
            {listing.counts.queues.map((entry) => (
              <span
                key={entry.queue}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs capitalize',
                  entry.waiting > 0
                    ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
                    : 'border-neutral-200 text-muted-foreground dark:border-neutral-800',
                )}
              >
                {dlqLabel(entry.queue)} · {entry.waiting}
              </span>
            ))}
          </div>
        </div>
      )}

      {listing && listing.deadLetters.length === 0 && !loadError && (
        <p className="rounded-md border border-neutral-200 px-3 py-6 text-center text-sm text-muted-foreground dark:border-neutral-800">
          Nothing parked. The dead-letter queues are empty.
        </p>
      )}

      {listing && listing.deadLetters.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-muted-foreground dark:border-neutral-800">
                <tr>
                  <th className="px-3 py-2 font-medium">Queue</th>
                  <th className="px-3 py-2 font-medium">Run</th>
                  <th className="px-3 py-2 font-medium">Failed with</th>
                  <th className="px-3 py-2 font-medium">Parked</th>
                </tr>
              </thead>
              <tbody>
                {listing.deadLetters.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => setSelectedId(row.id)}
                    aria-selected={row.id === selectedId}
                    className={cn(
                      'cursor-pointer border-b border-neutral-100 last:border-0 hover:bg-neutral-50 dark:border-neutral-900 dark:hover:bg-neutral-900',
                      row.id === selectedId && 'bg-indigo-50/60 dark:bg-indigo-950/40',
                    )}
                  >
                    <td className="px-3 py-2 capitalize">{dlqLabel(row.dlq)}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.flowRunId ?? row.executionId ?? '—'}</td>
                    <td className="max-w-sm truncate px-3 py-2 text-muted-foreground" title={row.failedReason ?? ''}>
                      {row.failedReason ?? 'no message recorded'}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                      {when(row.timestamps.enqueuedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <aside className="rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
            {!detail && (
              <p className="text-sm text-muted-foreground">Select a parked job to see its payload and the failure.</p>
            )}
            {detail && (
              <div className="space-y-4">
                <div>
                  <p className="font-mono text-xs text-muted-foreground">{detail.id}</p>
                  <p className="mt-1 text-sm">
                    {detail.jobName ?? 'job'} → {detail.queue ?? 'unknown queue'} · attempt{' '}
                    {detail.attemptsMade || 1}
                  </p>
                </div>

                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Workspace</dt>
                  <dd className="truncate font-mono">{detail.organizationId ?? '—'}</dd>
                  <dt className="text-muted-foreground">Run</dt>
                  <dd className="truncate font-mono">{detail.flowRunId ?? detail.executionId ?? '—'}</dd>
                  <dt className="text-muted-foreground">Parked</dt>
                  <dd>{when(detail.timestamps.enqueuedAt)}</dd>
                </dl>

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Failure</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                    {detail.failedReason ?? 'No message was recorded. Cross-reference Sentry for the stack trace.'}
                  </p>
                </div>

                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Payload</p>
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-neutral-50 p-2 text-[11px] leading-relaxed dark:bg-neutral-900">
                    {JSON.stringify(detail.payload ?? {}, null, 2)}
                  </pre>
                </div>

                <div className="flex flex-wrap gap-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !detail.replayable}
                    title={detail.replayable ? undefined : 'This record names no replayable origin queue.'}
                    onClick={() => void act('replay', detail)}
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Replay
                  </Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => void act('drop', detail)}>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Drop
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Re-running the flow or agent from the app is usually better than a replay: it ties into the run
                  history the app owns, where a raw replay re-enqueues the original job and leaves the failed run row
                  as it is.
                </p>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
