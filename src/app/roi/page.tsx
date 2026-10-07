'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ChartNoAxesCombined, ExternalLink, Loader2, Menu, MessageSquare, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ArtifactViewer } from '@/components/artifacts/artifact-viewer'
import { RoiReportFrame, NO_FILTERS, type ReportFilters } from '@/components/roi/report-frame'
import { RunProgress } from '@/components/roi/run-progress'
import { SettingsPanel } from '@/components/roi/settings-panel'
import { ReadoutLoader } from '@/components/roi/readout-loader'
import { describeRunConfig } from '@/lib/roi/config'
import { apiErrorMessage, isRunSettled, upsertRun } from '@/lib/roi/history'
import { cn } from '@/lib/utils'
import type { RoiAnalysisView, RoiOpenResult, RoiPageAccount, RoiPageSetup } from '@/lib/roi/types'

const LAST_ACCOUNT_KEY = 'backstory:roi-account'
const ASSISTANT_KEY = 'backstory:roi-assistant'

function stored(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function store(key: string, value: string) {
  try { window.localStorage.setItem(key, value) } catch { /* private mode: the URL still carries the account */ }
}
const same = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase())

/**
 * The ROI analysis page: the person's own ROI report, full width, with the
 * analyst beside it. Everyone starts from an account's report (Backstory's
 * own readout first); from then on the page is theirs — every settings
 * change, assistant edit or account they look up is the next version of
 * their page, saved as it happens. Nothing here creates an artifact.
 *
 * The menu button opens the side panel: which account, the report's filters,
 * the analysis settings, run history and what powers the page.
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
  // The person's page, once it shows the selected account.
  const [bound, setBound] = useState<{ account: string; artifactId: string } | null>(null)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const [assistantOpen, setAssistantOpen] = useState(true)
  const [filters, setFilters] = useState<ReportFilters>(NO_FILTERS)
  const [filterOptions, setFilterOptions] = useState<ReportFilters | null>(null)
  const [tab, setTab] = useState<string | null>(null)
  const [showVersion, setShowVersion] = useState<{ id: string; nonce: number } | null>(null)
  const [shownVersionId, setShownVersionId] = useState<string | null>(null)
  const [tracked, setTracked] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const lastCurrent = useRef<string | null>(null)
  const followPage = useRef(false)
  const pendingVersion = useRef<string | null>(null)
  const openingRef = useRef(false)
  // What the page last tried to open (account and its readiness), so a
  // failure or a missing report is not retried in a loop.
  const attempted = useRef<string | null>(null)

  useEffect(() => { if (stored(ASSISTANT_KEY) === '0') setAssistantOpen(false) }, [])

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

  // Which account opens: the link's; else Backstory's own readout once it is
  // built; else what the person's page shows, the last one viewed, or the
  // first with a report.
  useEffect(() => {
    if (!setup || account) return
    const find = (name: string | null | undefined) => (name ? setup.accounts.find((entry) => same(entry.account, name))?.account ?? null : null)
    const wanted = params?.get('account')?.trim() || null
    const chosen = find(wanted)
      ?? (wanted && setup.dataSource.kind === 'flow' ? wanted : null)
      ?? setup.defaultAccount
      ?? find(setup.page?.currentAccount)
      ?? find(stored(LAST_ACCOUNT_KEY))
      ?? setup.accounts.find((entry) => entry.mine)?.account
      ?? setup.accounts.find((entry) => entry.report?.ready)?.account
      ?? setup.accounts[0]?.account
      ?? null
    if (chosen) {
      if (!find(chosen)) setTypedAccount(chosen)
      setAccount(chosen)
    } else {
      setPanelOpen(true)
    }
  }, [setup, account, params])

  const selected: RoiPageAccount | null = useMemo(() => {
    if (!setup || !account) return null
    const known = setup.accounts.find((entry) => same(entry.account, account))
    if (known) return known
    return typedAccount === account
      ? { account, extracts: [], covers: [], loadedAt: null, report: null, mine: null, newerData: false, activeAnalysisId: null, canRefresh: setup.dataSource.kind === 'flow' }
      : null
  }, [setup, account, typedAccount])

  const applyOpen = useCallback((name: string, result: RoiOpenResult) => {
    if (result.status === 'ready') {
      setBound({ account: name, artifactId: result.artifactId })
      lastCurrent.current = result.versionId
      const show = pendingVersion.current
      pendingVersion.current = null
      setShowVersion(show ? { id: show, nonce: Date.now() } : null)
      setReload((n) => n + 1)
    } else {
      setBound(null)
    }
  }, [])

  const open = useCallback(async (name: string, update = false) => {
    setOpening(true)
    openingRef.current = true
    setOpenError(null)
    try {
      const response = await fetch('/api/roi/page/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: name, ...(update ? { update: true } : {}) }) })
      const data = await response.json().catch(() => ({})) as { result?: RoiOpenResult }
      if (!response.ok || !data.result) throw new Error(apiErrorMessage(data, `The ${name} report could not be opened.`))
      applyOpen(name, data.result)
      // The page now holds the account (or its newer data): the panel's settings start from it.
      void loadSetup()
      if (update) toast.success(`Your page has the newest ${name} data, with the findings written for it.`)
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error))
    } finally {
      // The pointer moved because we moved it: nothing to follow.
      followPage.current = false
      openingRef.current = false
      setOpening(false)
    }
  }, [applyOpen, loadSetup])

  // Show the selected account on the person's page: straight away when the
  // page already shows it, else opened there (its report put on the page the
  // first time). An account with no report waits for its first build.
  const readiness = `${Boolean(selected?.mine)}:${Boolean(selected?.report?.ready)}:${setup?.page?.artifactId ?? ''}`
  useEffect(() => {
    if (!setup || !account || !selected || opening) return
    if (bound && same(bound.account, account)) return
    // Shown straight away when the page already shows it (and was drawn with today's layout).
    if (selected.mine && !selected.mine.stale && setup.page && same(setup.page.currentAccount, account)) {
      setBound({ account, artifactId: setup.page.artifactId })
      if (pendingVersion.current) { setShowVersion({ id: pendingVersion.current, nonce: Date.now() }); pendingVersion.current = null }
      return
    }
    // `readiness` changes when a first build lands, which tries again.
    const key = `${account.toLowerCase()}|${readiness}`
    if (attempted.current === key) return
    attempted.current = key
    if (selected.mine || selected.report?.ready) void open(account)
  }, [setup, account, selected, bound, opening, open, readiness])

  // The page changed under us — the analyst put another account on it, or a
  // run finished: follow it, so the header and settings match what is shown.
  const onVersions = useCallback(({ shownVersionId: shown, currentVersionId }: { shownVersionId: string | null; currentVersionId: string | null }) => {
    setShownVersionId(shown)
    if (!openingRef.current && currentVersionId && lastCurrent.current && currentVersionId !== lastCurrent.current) {
      followPage.current = true
      void loadSetup()
    }
    lastCurrent.current = currentVersionId
  }, [loadSetup])

  useEffect(() => {
    if (!followPage.current || opening || !setup?.page || !bound || bound.artifactId !== setup.page.artifactId) return
    followPage.current = false
    const now = setup.page.currentAccount
    if (now && !same(now, account)) {
      setAccount(now)
      setBound({ account: now, artifactId: setup.page.artifactId })
      setFilters(NO_FILTERS)
      setFilterOptions(null)
      store(LAST_ACCOUNT_KEY, now)
      router.replace(`/roi?account=${encodeURIComponent(now)}`, { scroll: false })
    }
  }, [setup, bound, account, opening, router])

  // A run already updating this account (started here, elsewhere, or before a reload) is followed.
  useEffect(() => { if (selected?.activeAnalysisId) setTracked(selected.activeAnalysisId) }, [selected?.activeAnalysisId])
  const trackedRun = tracked ? analyses?.find((analysis) => analysis.id === tracked) ?? null : null

  const chooseAccount = useCallback((next: string, version?: string | null) => {
    pendingVersion.current = version ?? null
    attempted.current = null
    setAccount(next)
    if (setup && !setup.accounts.some((entry) => same(entry.account, next))) setTypedAccount(next)
    setFilters(NO_FILTERS)
    setFilterOptions(null)
    setShowVersion(null)
    setTracked(null)
    setOpenError(null)
    store(LAST_ACCOUNT_KEY, next)
    router.replace(`/roi?account=${encodeURIComponent(next)}`, { scroll: false })
  }, [router, setup])

  const linked = params?.get('account')?.trim() || null
  const latest = useRef({ account, ready: Boolean(setup), chooseAccount })
  latest.current = { account, ready: Boolean(setup), chooseAccount }
  useEffect(() => {
    const now = latest.current
    if (now.ready && now.account && linked && !same(linked, now.account)) now.chooseAccount(linked)
  }, [linked])

  const onStarted = useCallback((analysis: RoiAnalysisView) => {
    setAnalyses((current) => upsertRun(current ?? [], analysis))
    setTracked(analysis.id)
    setPanelOpen(false)
    void loadSetup()
    toast.success(analysis.mode === 'reconfigure' ? 'Rewriting the findings for the new settings. Your page updates when it is done.' : 'Building the report from the account\'s data. Your page updates when it is done.')
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
    setPanelOpen(false)
    if (!same(run.account, account)) { chooseAccount(run.account, run.pageVersionId); return }
    if (run.pageVersionId) setShowVersion({ id: run.pageVersionId, nonce: Date.now() })
  }, [account, chooseAccount])

  const onPageChanged = useCallback((result: RoiOpenResult) => {
    if (account) applyOpen(account, result)
    void loadSetup()
  }, [account, applyOpen, loadSetup])

  const toggleAssistant = () => setAssistantOpen((value) => { store(ASSISTANT_KEY, value ? '0' : '1'); return !value })

  const busy = Boolean(trackedRun && !isRunSettled(trackedRun.phase)) || Boolean(selected?.activeAnalysisId)
  const shownSettings = selected?.mine ?? selected?.report ?? null
  const configLine = shownSettings ? [...describeRunConfig(shownSettings.config), ...(shownSettings.reason ? [`for ${shownSettings.reason}`] : [])] : []
  const filterCount = filters.fy.length + filters.fq.length + filters.role.length
  const showing = bound && same(bound.account, account) ? bound : null

  if (setupError && !setup) {
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
      {/* Below lg the app's navigation button floats at the top left; the header starts beside it. */}
      <div className="flex flex-wrap items-center gap-3 pl-12 lg:pl-0">
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
          {showing && shownVersionId && (
            <a href={`/api/artifacts/${showing.artifactId}/versions/${shownVersionId}/content`} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1 rounded-md border border-input px-2.5 text-xs font-medium hover:bg-muted">
              Open full page <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
          {showing && (
            <Button type="button" variant={assistantOpen ? 'secondary' : 'outline'} size="sm" onClick={toggleAssistant} aria-pressed={assistantOpen} className="gap-1.5">
              <MessageSquare className="h-4 w-4" aria-hidden />Ask the analyst
            </Button>
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

      {showing && selected?.newerData && !busy && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-lg border border-horizon-200 bg-horizon-50/70 px-3 py-2 text-sm text-horizon-900 dark:bg-horizon-950/30 dark:text-horizon-100">
          <span>The {selected.account} report has newer data than your page.</span>
          <Button type="button" size="sm" variant="outline" disabled={opening} onClick={() => void open(selected.account, true)} className="ml-auto gap-1.5 bg-background">
            {opening ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}Update my page
          </Button>
        </div>
      )}

      {openError && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span>{openError}</span>
          {account && <Button type="button" variant="outline" size="sm" disabled={opening} onClick={() => void open(account)}>Try again</Button>}
        </div>
      )}

      {showing ? (
        <ArtifactViewer
          key={`${showing.artifactId}:${reload}`}
          id={showing.artifactId}
          embedded
          showAssistant={assistantOpen}
          showVersion={showVersion}
          onVersions={onVersions}
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
      ) : opening ? (
        <div role="status" className="flex min-h-[60vh] flex-col items-center justify-center gap-3 rounded-xl border bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin text-horizon-600" aria-hidden />
          {selected?.mine ? `Opening ${account}…` : `Putting the ${account} report on your page…`}
        </div>
      ) : account && same(account, 'Backstory') && !busy ? (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-8 text-center">
          <ChartNoAxesCombined className="h-6 w-6 text-horizon-600" aria-hidden />
          <h2 className="text-lg font-semibold tracking-tight">Backstory&apos;s ROI readout</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {setup.canLoadExtracts
              ? 'Backstory\'s own page is built from its value readout. Load the readout page (.html) and the report builds here in seconds, for everyone.'
              : 'Backstory\'s own page is built from its value readout, which has not been loaded yet. A platform admin loads it from here.'}
          </p>
          {setup.canLoadExtracts && <ReadoutLoader account="Backstory" onLoaded={(result, name) => { applyOpen(name, result); void loadSetup(); void loadHistory() }} />}
        </div>
      ) : (
        <div className={cn('flex min-h-[60vh] flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-8 text-center')}>
          <SlidersHorizontal className="h-6 w-6 text-horizon-600" aria-hidden />
          <h2 className="text-lg font-semibold tracking-tight">{account ? (busy ? `Building the ${account} report` : `${account} has no ROI report yet`) : 'Choose an account'}</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {!account
              ? 'Open the panel to choose an account.'
              : busy
                ? 'It lands here, on your page, when the run finishes. You can leave; you will be notified.'
                : 'Open the settings, say why it is being run, and build it. It lands here, on your page, and every change after that saves to your page.'}
          </p>
          {!busy && <Button type="button" onClick={() => setPanelOpen(true)}><Menu className="h-4 w-4" aria-hidden />{account ? 'Open the settings' : 'Choose an account'}</Button>}
        </div>
      )}

      <SettingsPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        setup={setup}
        account={selected}
        onAccountChange={(next) => chooseAccount(next)}
        filters={filters}
        filterOptions={filterOptions}
        onFiltersChange={setFilters}
        analyses={analyses}
        historyError={historyError}
        onStarted={onStarted}
        onOpenRun={onOpenRun}
        onDataSourceChange={(dataSource) => { setSetup((current) => (current ? { ...current, dataSource } : current)); void loadSetup() }}
        onPageChanged={onPageChanged}
        onExtractsLoaded={() => { void loadSetup() }}
        busy={busy}
      />
    </div>
  )
}
