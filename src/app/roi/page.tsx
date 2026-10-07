'use client'

import { useCallback, useEffect, useState } from 'react'
import { ChartNoAxesCombined, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageSetupCard } from '@/components/roi/page-setup-card'
import { RunForm } from '@/components/roi/run-form'
import { RunHistory } from '@/components/roi/run-history'
import { RunProgress } from '@/components/roi/run-progress'
import { aboutDuration, apiErrorMessage, isRunSettled, upsertRun } from '@/lib/roi/history'
import type { RoiAnalysisView, RoiPageSetup } from '@/lib/roi/types'

// Used until the page's setup arrives (and if it never does).
const FALLBACK_EXPECTED_SECONDS = 90
const FALLBACK_ASYNC_AFTER_SECONDS = 180

/**
 * The ROI analysis page: pick an account, say why, run. The page — not the
 * ROI agent — is the entry point; the agent runs behind it. Runs started here
 * (and any still running when the page opens) are followed live, and every
 * run lands in the history below, one folder per account.
 */
export default function RoiPage() {
  const [setup, setSetup] = useState<RoiPageSetup | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [analyses, setAnalyses] = useState<RoiAnalysisView[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [tracked, setTracked] = useState<string[]>([])
  const [revealId, setRevealId] = useState<string | null>(null)

  const loadSetup = useCallback(async () => {
    try {
      const response = await fetch('/api/roi/page', { cache: 'no-store' })
      const data = await response.json().catch(() => ({})) as { setup?: RoiPageSetup }
      if (!response.ok || !data.setup) throw new Error(apiErrorMessage(data, 'The page could not load its accounts.'))
      setSetup(data.setup)
      setSetupError(null)
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch('/api/roi/analyses', { cache: 'no-store' })
      const data = await response.json().catch(() => ({})) as { analyses?: RoiAnalysisView[] }
      if (!response.ok) throw new Error(apiErrorMessage(data, 'The run history could not load.'))
      const list = data.analyses ?? []
      setAnalyses(list)
      setHistoryError(null)
      // Anything still running is followed too, wherever it was started.
      const running = list.filter((analysis) => !isRunSettled(analysis.phase)).map((analysis) => analysis.id)
      if (running.length) setTracked((current) => [...current, ...running.filter((id) => !current.includes(id))])
    } catch (error) {
      setAnalyses((current) => current ?? [])
      setHistoryError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void loadSetup()
    void loadHistory()
  }, [loadSetup, loadHistory])

  // Bring a run just started into view, and focus it for keyboard users.
  useEffect(() => {
    if (!revealId) return
    const element = document.getElementById(`roi-run-${revealId}`)
    if (!element) return
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' })
    element.focus({ preventScroll: true })
    setRevealId(null)
  }, [revealId, tracked])

  const onCreated = useCallback((analysis: RoiAnalysisView) => {
    setAnalyses((current) => upsertRun(current ?? [], analysis))
    setTracked((current) => [analysis.id, ...current.filter((id) => id !== analysis.id)])
    setRevealId(analysis.id)
  }, [])

  const onChange = useCallback((analysis: RoiAnalysisView) => {
    setAnalyses((current) => upsertRun(current ?? [], analysis))
  }, [])

  const onSettled = useCallback(() => { void loadHistory() }, [loadHistory])

  const onDataSourceChange = useCallback((dataSource: RoiPageSetup['dataSource']) => {
    setSetup((current) => (current ? { ...current, dataSource } : current))
    // The source decides which accounts can run; read them again.
    void loadSetup()
  }, [loadSetup])

  const trackedRuns = tracked
    .map((id) => analyses?.find((analysis) => analysis.id === id))
    .filter((analysis): analysis is RoiAnalysisView => Boolean(analysis))
  const expectedSeconds = setup?.expectedSeconds ?? FALLBACK_EXPECTED_SECONDS
  const asyncAfterSeconds = setup?.asyncAfterSeconds ?? FALLBACK_ASYNC_AFTER_SECONDS

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-horizon-700"><ChartNoAxesCombined className="h-3.5 w-3.5" aria-hidden /> ROI analysis</div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Who do you want to run the analysis for?</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          A standardized ROI readout for one customer account, built from its own data. Runs take about {aboutDuration(expectedSeconds)}.
        </p>
      </div>

      {setupError ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span>{setupError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => { setSetupError(null); void loadSetup() }}>Try again</Button>
        </div>
      ) : !setup ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
          <RunForm setup={setup} onCreated={onCreated} />
          <PageSetupCard setup={setup} onDataSourceChange={onDataSourceChange} />
        </div>
      )}

      {trackedRuns.length > 0 && (
        <section aria-labelledby="roi-current-heading" className="space-y-3">
          <h2 id="roi-current-heading" className="text-lg font-semibold tracking-tight">Current runs</h2>
          {trackedRuns.map((analysis) => (
            <RunProgress
              key={analysis.id}
              analysis={analysis}
              expectedSeconds={expectedSeconds}
              asyncAfterSeconds={asyncAfterSeconds}
              onChange={onChange}
              onSettled={onSettled}
              onDismiss={() => setTracked((current) => current.filter((id) => id !== analysis.id))}
            />
          ))}
        </section>
      )}

      <RunHistory analyses={analyses} error={historyError} />
    </div>
  )
}
