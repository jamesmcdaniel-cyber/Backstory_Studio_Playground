'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { AlertCircle, Check, CircleCheck, Clock, FileOutput, Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { startVisibleInterval } from '@/lib/client/visible-interval'
import { cn } from '@/lib/utils'
import { ROI_RUN_STEPS, aboutDuration, formatElapsed, isRunSettled, stepStates } from '@/lib/roi/history'
import type { RoiAnalysisView } from '@/lib/roi/types'

const POLL_MS = 3000
/** Consecutive failed polls before the card says the run cannot be reached. */
const UNREACHABLE_AFTER = 5

type Props = {
  analysis: RoiAnalysisView
  /** Typical run length, for the estimate. */
  expectedSeconds: number
  /** Past this, the card says the run is slow and the user will be notified. */
  asyncAfterSeconds: number
  /** Every fresh read of the run (the page keeps its history in step). */
  onChange: (analysis: RoiAnalysisView) => void
  /** Once, when the run becomes ready or fails while the page watches it. */
  onSettled: (analysis: RoiAnalysisView) => void
  onDismiss: () => void
}

/**
 * One run, followed live: a stepper through the four phases, an elapsed
 * clock against the usual duration, and — once it runs long — a note that
 * the user can leave. Polls the analysis every 3 seconds while the tab is
 * visible until it is ready or failed.
 */
export function RunProgress({ analysis, expectedSeconds, asyncAfterSeconds, onChange, onSettled, onDismiss }: Props) {
  const router = useRouter()
  const settled = isRunSettled(analysis.phase)
  const handlers = useRef({ onChange, onSettled })
  useEffect(() => { handlers.current = { onChange, onSettled } }, [onChange, onSettled])

  useEffect(() => {
    if (settled) return
    let cancelled = false
    let busy = false
    let failures = 0
    const tick = () => {
      if (busy) return
      busy = true
      fetch(`/api/roi/analyses/${analysis.id}`, { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((data: { analysis?: RoiAnalysisView } | null) => {
          failures = 0
          if (!cancelled) setUnreachable(false)
          if (!cancelled && data?.analysis) handlers.current.onChange(data.analysis)
        })
        // A run the page cannot reach used to spin silently until a reload;
        // after a few misses the card says so and keeps trying.
        .catch(() => { failures += 1; if (!cancelled && failures >= UNREACHABLE_AFTER) setUnreachable(true) })
        .finally(() => { busy = false })
    }
    const stop = startVisibleInterval(tick, POLL_MS)
    return () => { cancelled = true; stop() }
  }, [analysis.id, settled])

  const [unreachable, setUnreachable] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (settled) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [settled])

  // Announce the moment it settles, once.
  const lastPhase = useRef(analysis.phase)
  useEffect(() => {
    const before = lastPhase.current
    lastPhase.current = analysis.phase
    if (isRunSettled(before) || !isRunSettled(analysis.phase)) return
    if (analysis.phase === 'ready') {
      const artifactId = analysis.artifactId
      toast.success(`The ROI report for ${analysis.account} is ready.`, artifactId ? { action: { label: 'Open report', onClick: () => router.push(`/roi?account=${encodeURIComponent(analysis.account)}`) } } : undefined)
    } else {
      toast.error(`The ROI analysis for ${analysis.account} did not finish.`)
    }
    handlers.current.onSettled(analysis)
  }, [analysis, router])

  const started = Date.parse(analysis.createdAt)
  const ended = settled ? Date.parse(analysis.completedAt ?? analysis.updatedAt) : now
  const elapsed = Number.isFinite(started) && Number.isFinite(ended) ? (ended - started) / 1000 : 0
  const slow = !settled && elapsed > asyncAfterSeconds
  const states = stepStates(analysis.phase)
  const activeStep = ROI_RUN_STEPS.find((_, index) => states[index] === 'active')

  return (
    <section
      id={`roi-run-${analysis.id}`}
      tabIndex={-1}
      aria-label={`ROI analysis for ${analysis.account}`}
      className="rounded-xl border bg-card p-5 shadow-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-semibold">{analysis.account}</p>
          {analysis.reason && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{analysis.reason}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
            <Clock className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Elapsed </span>{formatElapsed(elapsed)}
          </span>
          {settled && (
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onDismiss} aria-label={`Dismiss the run for ${analysis.account}`}>
              <X className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {analysis.phase === 'failed' ? (
        <div role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
          <p className="flex items-start gap-2"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{analysis.error || 'The analysis did not finish.'}</p>
          {analysis.executionId && <Link href={`/agents?run=${analysis.executionId}`} className="ml-6 mt-1 inline-block text-xs font-medium underline underline-offset-2">Open the run</Link>}
        </div>
      ) : analysis.phase === 'ready' ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--status-good-bg)] px-3 py-2.5">
          <p className="flex items-center gap-2 text-sm font-medium text-[var(--status-good-fg)]"><CircleCheck className="h-4 w-4" aria-hidden />The report is ready.</p>
          <Button asChild size="sm">
            <Link href={`/roi?account=${encodeURIComponent(analysis.account)}`}>
              <FileOutput className="h-4 w-4" aria-hidden />Open report
            </Link>
          </Button>
        </div>
      ) : (
        <>
          {unreachable && (
            <p role="status" className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              This run cannot be reached right now. The page keeps checking; it also updates when the run lands.
            </p>
          )}
          <ol aria-label="Progress" className="mt-4 grid gap-3 sm:grid-cols-4">
            {ROI_RUN_STEPS.map((step, index) => {
              const state = states[index]
              return (
                <li key={step.phase} aria-current={state === 'active' ? 'step' : undefined} className="space-y-2">
                  <span aria-hidden className={cn('block h-1 rounded-full', state === 'done' ? 'bg-horizon-600' : state === 'active' ? 'animate-pulse bg-horizon-300' : 'bg-graphite-200')} />
                  <span className="flex items-center gap-2 text-sm">
                    <span aria-hidden className={cn(
                      'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                      state === 'done' ? 'bg-horizon-600 text-white' : state === 'active' ? 'bg-horizon-50 text-horizon-700 ring-1 ring-horizon-300' : 'bg-graphite-100 text-fg-muted',
                    )}>
                      {state === 'done' ? <Check className="h-3 w-3" /> : state === 'active' ? <Loader2 className="h-3 w-3 animate-spin" /> : index + 1}
                    </span>
                    <span className={state === 'pending' ? 'text-muted-foreground' : 'font-medium text-foreground'}>{step.label}</span>
                    <span className="sr-only">{state === 'done' ? ', done' : state === 'active' ? ', in progress' : ''}</span>
                  </span>
                </li>
              )
            })}
          </ol>
          <p className="sr-only" aria-live="polite">{analysis.phase === 'queued' ? 'Queued' : activeStep?.label ?? ''}</p>
          {slow ? (
            <p className="mt-4 rounded-lg border border-horizon-100 bg-horizon-50/60 px-3 py-2 text-sm text-foreground">
              This one is taking longer than usual. You can leave this page; we'll notify you when the report is ready.
            </p>
          ) : (
            <p className="mt-4 text-xs text-muted-foreground">
              {analysis.phase === 'queued' ? 'Queued — it starts in a moment. ' : ''}Usually about {aboutDuration(expectedSeconds)}.
            </p>
          )}
        </>
      )}
    </section>
  )
}
