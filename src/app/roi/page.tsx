'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { ChartNoAxesCombined, ExternalLink, Loader2, Menu, MessageSquare, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ArtifactViewer } from '@/components/artifacts/artifact-viewer'
import { RoiReportFrame, NO_FILTERS, type ReportFilters } from '@/components/roi/report-frame'
import { RunProgress } from '@/components/roi/run-progress'
import { SettingsPanel } from '@/components/roi/settings-panel'
import { describeRunConfig } from '@/lib/roi/config'
import { apiErrorMessage, isRunSettled, upsertRun } from '@/lib/roi/history'
import { cn } from '@/lib/utils'
import type { RoiAnalysisView, RoiPageAccount, RoiPageSetup } from '@/lib/roi/types'

const LAST_ACCOUNT_KEY = 'backstory:roi-account'

function rememberedAccount(): string | null {
  try { return window.localStorage.getItem(LAST_ACCOUNT_KEY) } catch { return null }
}
function rememberAccount(account: string) {
  try { window.localStorage.setItem(LAST_ACCOUNT_KEY, account) } catch { /* private mode: the URL still carries it */ }
}

/**
 * The ROI analysis page: the account's ROI report, full width — the Iron
 * Mountain dashboard with Backstory's value-readout views added — and,
 * behind the menu button, a side panel with everything that shapes it:
 * which account, the report's filters, the analysis settings, run history.
 * Settings change this report (its next version); an account never gets a
 * second one. The assistant opens beside the report.
 */
export default function RoiPage() {
  const router = useRouter()
  const params = useSearchParams()
  const [setup, setSetup] = useState<RoiPageSetup | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [analyses, setAnalyses] = useState<RoiAnalysisView[] | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const [typedAccount, setTypedAccount] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [filters, setFilters] = useState<ReportFilters>(NO_FILTERS)
  const [filterOptions, setFilterOptions] = useState<ReportFilters | null>(null)
  const [tab, setTab] = useState<string | null>(null)
  const [showVersion, setShowVersion] = useState<{ id: string; nonce: number } | null>(null)
  const [tracked, setTracked] = useState<string | null>(null)
  const [reload, setReload] = useState(0)

  const loadSetup = useCallback(async () => {
    try {
      const response = await fetch('/api/roi/page', { cache: 'no-store' })
      const data = await response.json().catch(() => ({})) as { setup?: RoiPageSetup }
      if (!response.ok || !data.setup) throw new Error(apiErrorMessage(data, 'The ROI analysis page could not load.'))
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
      setAnalyses(data.analyses ?? [])
      setHistoryError(null)
    } catch (error) {
      setAnalyses((current) => current ?? [])
      setHistoryError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => { void loadSetup(); void loadHistory() }, [loadSetup, loadHistory])

  // Which account opens: the link's, else the last one viewed, else the first with a report.
  useEffect(() => {
    if (!setup || account) return
    const wanted = params?.get('account') ?? rememberedAccount()
    const match = wanted ? setup.accounts.find((entry) => entry.account.toLowerCase() === wanted.toLowerCase()) : null
    const chosen = match?.account ?? setup.accounts.find((entry) => entry.report?.ready)?.account ?? setup.accounts.find((entry) => entry.report)?.account ?? setup.accounts[0]?.account ?? null
    if (chosen) setAccount(chosen)
    else setPanelOpen(true)
  }, [setup, account, params])

  const selected: RoiPageAccount | null = useMemo(() => {
    if (!setup || !account) return null
    const known = setup.accounts.find((entry) => entry.account === account)
    if (known) return known
    return typedAccount === account ? { account, extracts: [], covers: [], loadedAt: null, report: null, canRefresh: setup.dataSource.kind === 'flow' } : null
  }, [setup, account, typedAccount])
  const report = selected?.report ?? null

  // A run already updating this report (started here, elsewhere, or before a reload) is followed.
  useEffect(() => { if (report?.activeAnalysisId) setTracked(report.activeAnalysisId) }, [report?.activeAnalysisId])
  const trackedRun = tracked ? analyses?.find((analysis) => analysis.id === tracked) ?? null : null

  const chooseAccount = useCallback((next: string) => {
    setAccount(next)
    if (setup && !setup.accounts.some((entry) => entry.account === next)) setTypedAccount(next)
    setFilters(NO_FILTERS)
    setFilterOptions(null)
    setShowVersion(null)
    setTracked(null)
    rememberAccount(next)
    router.replace(`/roi?account=${encodeURIComponent(next)}`, { scroll: false })
  }, [router, setup])

  const onStarted = useCallback((analysis: RoiAnalysisView) => {
    setAnalyses((current) => upsertRun(current ?? [], analysis))
    setTracked(analysis.id)
    setPanelOpen(false)
    void loadSetup()
    toast.success(analysis.mode === 'reconfigure' ? 'Rewriting the findings for the new settings. The report updates in place.' : 'Building the report. It updates in place when the run finishes.')
  }, [loadSetup])

  const onRunChange = useCallback((analysis: RoiAnalysisView) => {
    setAnalyses((current) => upsertRun(current ?? [], analysis))
  }, [])

  const onRunSettled = useCallback(() => {
    void loadHistory()
    void loadSetup()
    setReload((n) => n + 1)
  }, [loadHistory, loadSetup])

  const onOpenRun = useCallback((run: RoiAnalysisView) => {
    if (run.account.toLowerCase() !== (account ?? '').toLowerCase()) chooseAccount(run.account)
    if (run.versionId) setShowVersion({ id: run.versionId, nonce: Date.now() })
    setPanelOpen(false)
  }, [account, chooseAccount])

  const busy = Boolean(trackedRun && !isRunSettled(trackedRun.phase)) || Boolean(report?.activeAnalysisId)
  const configLine = report ? [...describeRunConfig(report.config), ...(report.reason ? [`for ${report.reason}`] : [])] : []
  const filterCount = filters.fy.length + filters.fq.length + filters.role.length

  if (setupError) {
    return (
      <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        <span>{setupError}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => { setSetupError(null); void loadSetup() }}>Try again</Button>
      </div>
    )
  }
  if (!setup) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Loading…</div>

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => setPanelOpen(true)} aria-haspopup="dialog" aria-expanded={panelOpen} className="gap-2">
          <Menu className="h-4 w-4" aria-hidden />
          <span>Filters</span>
          {filterCount > 0 && <span className="rounded-full bg-horizon-600 px-1.5 text-[10px] font-semibold text-white">{filterCount}</span>}
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-horizon-700"><ChartNoAxesCombined className="h-3.5 w-3.5" aria-hidden /> ROI analysis</div>
          <h1 className="truncate text-lg font-semibold tracking-tight">{account ?? 'Choose an account'}</h1>
        </div>
        {configLine.length > 0 && (
          <button type="button" onClick={() => setPanelOpen(true)} className="hidden min-w-0 flex-wrap items-center gap-1.5 text-left lg:flex" title="Change the settings">
            {configLine.map((line) => <span key={line} className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground">{line}</span>)}
          </button>
        )}
        <div className="ml-auto flex items-center gap-2">
          {report && (
            <Button type="button" variant={assistantOpen ? 'secondary' : 'outline'} size="sm" onClick={() => setAssistantOpen((open) => !open)} aria-pressed={assistantOpen} className="gap-1.5">
              <MessageSquare className="h-4 w-4" aria-hidden />Ask the analyst
            </Button>
          )}
          {report && (
            <Link href={`/artifacts/${report.artifactId}`} className="inline-flex h-8 items-center gap-1 rounded-md border border-input px-2.5 text-xs font-medium hover:bg-muted">
              Versions and sharing <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>
      </div>

      {trackedRun && (
        <RunProgress
          analysis={trackedRun}
          expectedSeconds={trackedRun.mode === 'reconfigure' ? setup.reconfigureSeconds : setup.expectedSeconds}
          asyncAfterSeconds={setup.asyncAfterSeconds}
          onChange={onRunChange}
          onSettled={onRunSettled}
          onDismiss={() => setTracked(null)}
        />
      )}

      {report ? (
        <ArtifactViewer
          key={`${report.artifactId}:${reload}`}
          id={report.artifactId}
          embedded
          showAssistant={assistantOpen}
          showVersion={showVersion}
          renderFrame={({ artifactId, versionId, title, className }) => (
            <RoiReportFrame
              artifactId={artifactId}
              versionId={versionId}
              title={title}
              className={className}
              filters={filters}
              tab={tab}
              onOptions={setFilterOptions}
              onTab={setTab}
            />
          )}
        />
      ) : (
        <div className={cn('flex min-h-[60vh] flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-8 text-center')}>
          <SlidersHorizontal className="h-6 w-6 text-horizon-600" aria-hidden />
          <h2 className="text-lg font-semibold tracking-tight">{account ? `${account} has no ROI report yet` : 'Choose an account'}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {account ? 'Open the filters to choose the analysis settings and say why it is being run; the report is built here and updated in place from then on.' : 'Open the filters to choose an account.'}
          </p>
          <Button type="button" onClick={() => setPanelOpen(true)}><Menu className="h-4 w-4" aria-hidden />Open filters and settings</Button>
        </div>
      )}

      <SettingsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        setup={setup}
        account={selected}
        onAccountChange={chooseAccount}
        filters={filters}
        filterOptions={filterOptions}
        onFiltersChange={setFilters}
        analyses={analyses}
        historyError={historyError}
        onStarted={onStarted}
        onOpenRun={onOpenRun}
        onDataSourceChange={(dataSource) => { setSetup((current) => (current ? { ...current, dataSource } : current)); void loadSetup() }}
        busy={busy}
      />
    </div>
  )
}
