'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, AlertTriangle, CalendarRange, Info, Loader2, Play, RefreshCw, RotateCcw, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AccountSelect } from '@/components/roi/account-select'
import { ExtractLoader } from '@/components/roi/extract-loader'
import { ReadoutLoader } from '@/components/roi/readout-loader'
import { PageSetupCard } from '@/components/roi/page-setup-card'
import { PanelSection, SegmentedControl } from '@/components/roi/panel-section'
import { RunHistory } from '@/components/roi/run-history'
import { REASON_MAX_CHARS, REASON_REQUIRED, useRoiSettings, type RoiSettings, type RoiWindowChoice } from '@/components/roi/use-roi-settings'
import type { ReportFilters } from '@/components/roi/report-frame'
import {
  MONTH_NAMES,
  ROI_COHORT_OPTIONS,
  ROI_COMPARISON_OPTIONS,
  ROI_IDEAL_WINDOW_MONTHS,
  ROI_REASON_PRESETS,
  ROI_WINDOW_OPTIONS,
  describeRunConfig,
  monthLabel,
  type RoiCohortType,
  type RoiComparison,
} from '@/lib/roi/config'
import { aboutDuration, accountStatusLine, apiErrorMessage, hasReasonPreset, runsOfAccount, runsSummary, sinceLabel, type RoiApplyMode } from '@/lib/roi/history'
import type { RoiAnalysisView, RoiOpenResult, RoiPageAccount, RoiPageSetup } from '@/lib/roi/types'

type SectionId = 'filters' | 'settings' | 'reason' | 'history' | 'data'

const NETWORK_ERROR = 'The page could not reach the server. Check your connection and try again.'
const FIELD = 'w-full rounded-md border border-input bg-background text-foreground transition-colors duration-fast hover:border-graphite-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-red-500'
const CHIP = 'rounded-full border px-2 py-0.5 text-xs font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const CHIP_ON = 'border-horizon-600 bg-horizon-600 text-white hover:bg-horizon-700'
const CHIP_OFF = 'border-border bg-background text-foreground hover:bg-muted'
const TEXT_BUTTON = 'inline-flex items-center gap-1 rounded px-1 text-xs font-medium text-horizon-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

const FILTER_GROUPS: Array<{ key: keyof ReportFilters; label: string }> = [
  { key: 'fy', label: 'Fiscal year' },
  { key: 'fq', label: 'Quarter' },
  { key: 'role', label: 'Role' },
]

const WINDOW_CHOICES: Array<{ value: RoiWindowChoice; label: string; srLabel: string; title: string }> = [
  ...ROI_WINDOW_OPTIONS.map((option) => ({
    value: option.value as RoiWindowChoice,
    label: `${option.value} mo`,
    srLabel: ` — ${option.label.toLowerCase()}${option.value === ROI_IDEAL_WINDOW_MONTHS ? ', recommended' : ''}`,
    title: option.hint ? `${option.label} (${option.hint.charAt(0).toLowerCase()}${option.hint.slice(1)})` : option.label,
  })),
  { value: 'custom', label: 'Custom', srLabel: ' periods', title: 'Choose the baseline and observation months yourself' },
]
const COMPARISON_LABEL: Record<RoiComparison, string> = { prior: 'Previous period', year_ago: 'Same period last year' }
const COHORT_LABEL: Record<RoiCohortType, string> = { tiers: 'Adoption tiers', users: 'Users vs non-users' }

/** Tab and Shift+Tab stay inside the panel while it is open. */
function keepFocusIn(container: HTMLElement | null, event: KeyboardEvent) {
  if (!container) return
  const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((item) => item.getClientRects().length > 0)
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement
  if (!active || !container.contains(active)) {
    event.preventDefault()
    const target = event.shiftKey ? last : first
    target.focus()
  } else if (event.shiftKey && (active === first || active === container)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

/** What the primary action will do, in one line. */
function applyLine({ working, unchanged, mode, setup }: { working: boolean; unchanged: boolean; mode: RoiApplyMode; setup: RoiPageSetup }): string {
  if (working) return 'This page is being updated now. Apply again once it lands.'
  if (unchanged) return 'Change a setting or the reason, then apply.'
  if (mode === 'rewrite') return `Rewrites the findings on your page's data — about ${aboutDuration(setup.reconfigureSeconds)}.`
  if (mode === 'rebuild') return `Rebuilds your page from the account's data — about ${aboutDuration(setup.expectedSeconds)}.`
  return `Builds the report from the account's data — about ${aboutDuration(setup.expectedSeconds)}.`
}

/**
 * The ROI page's side panel, opened from its menu button: everything that
 * shapes the report on screen. The account (and whether newer data waits for
 * this person's page) stays at the top; below it, collapsible sections — the
 * report's filters (applied live), the analysis settings and the reason
 * (applied together as the page's next version), run history, and what
 * powers the page. The primary action is pinned to the bottom, so it is
 * never a scroll away.
 */
export function SettingsPanel({ open, onClose, setup, account, onAccountChange, filters, filterOptions, onFiltersChange, analyses, historyError, onStarted, onOpenRun, onDataSourceChange, onPageChanged, onExtractsLoaded, busy }: {
  open: boolean
  onClose: () => void
  setup: RoiPageSetup
  account: RoiPageAccount | null
  onAccountChange: (account: string) => void
  filters: ReportFilters
  filterOptions: ReportFilters | null
  onFiltersChange: (filters: ReportFilters) => void
  analyses: RoiAnalysisView[] | null
  historyError: string | null
  onStarted: (analysis: RoiAnalysisView) => void
  onOpenRun: (run: RoiAnalysisView) => void
  onDataSourceChange: (dataSource: RoiPageSetup['dataSource']) => void
  /** This person's page took the account report's newer data ("Update my page"). */
  onPageChanged: (result: RoiOpenResult) => void
  /** An operator loaded extracts from the panel: the accounts and their data changed. */
  onExtractsLoaded: () => void
  /** A run is updating this page. */
  busy: boolean
}) {
  const working = busy || Boolean(account?.activeAnalysisId)
  const settings = useRoiSettings({ account, busy: working, onStarted })
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  // Which sections are open: the person's choices, over defaults that follow
  // the account. Choosing another account starts from the defaults again.
  const accountKey = account?.account.trim().toLowerCase() ?? ''
  const [sections, setSections] = useState<{ account: string; open: Partial<Record<SectionId, boolean>> }>({ account: accountKey, open: {} })
  if (sections.account !== accountKey) setSections({ account: accountKey, open: {} })
  const [focusRequest, setFocusRequest] = useState<{ id: string; at: number } | null>(null)
  // "Update my page", for the version of the page it was asked on.
  const pageKey = `${accountKey}|${account?.mine?.versionId ?? ''}`
  const [pageUpdate, setPageUpdate] = useState<{ key: string; state: 'updating' | 'done' | 'error'; message?: string } | null>(null)
  const update = pageUpdate?.key === pageKey ? pageUpdate : null

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        onCloseRef.current()
      } else if (event.key === 'Tab') {
        keepFocusIn(dialogRef.current, event)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  // A submit the form stopped: the section is open by now; focus the field.
  useEffect(() => {
    if (!focusRequest) return
    const element = document.getElementById(focusRequest.id)
    if (!element) return
    element.focus({ preventScroll: true })
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollIntoView?.({ block: 'center', behavior: reduce ? 'auto' : 'smooth' })
  }, [focusRequest])

  if (!open || typeof document === 'undefined') return null

  const hasPage = Boolean(account && (account.mine || account.report))
  const groups = FILTER_GROUPS.filter((group) => (filterOptions?.[group.key] ?? []).length > 0)
  const activeFilters = [...filters.fy, ...filters.fq, ...filters.role]
  const defaults: Record<SectionId, boolean> = {
    filters: groups.length > 0,
    settings: false,
    reason: !settings.baseline.reason.trim(),
    history: false,
    data: setup.canLoadExtracts && setup.accounts.length === 0,
  }
  const isOpen = (id: SectionId) => sections.open[id] ?? defaults[id]
  const setOpen = (id: SectionId) => (value: boolean) => setSections((current) => ({ ...current, open: { ...current.open, [id]: value } }))

  const accountRuns = analyses && account ? runsOfAccount(analyses, account.account) : null
  const historySummary = analyses === null
    ? 'Loading…'
    : account && accountRuns && !accountRuns.length
      ? 'No runs for this account yet'
      : runsSummary(accountRuns ?? analyses)
  const dataSummary = [
    setup.agent.title,
    setup.dataSource.kind === 'flow' ? `${setup.dataSource.flowName ?? 'data'} flow` : 'loaded extracts',
    setup.backstory.connected ? 'Backstory connected' : 'Backstory not connected',
  ].join(' · ')

  const mode = settings.mode ?? 'build'
  const unchanged = Boolean(account?.mine) && !settings.configDirty && !settings.reasonDirty
  const showRefresh = Boolean(account && (account.report || account.mine) && account.canRefresh)
  const submitting = settings.submitting

  const submit = async (refresh: boolean) => {
    const problems = await settings.submit(refresh)
    if (!problems.length) return
    setSections((current) => ({
      ...current,
      open: {
        ...current.open,
        ...(problems.includes('config') ? { settings: true } : {}),
        ...(problems.includes('reason') ? { reason: true } : {}),
      },
    }))
    setFocusRequest({ id: problems[0] === 'config' ? settings.invalidFieldId ?? 'roi-section-settings-button' : 'roi-reason', at: Date.now() })
  }

  const updatePage = async () => {
    if (!account || update?.state === 'updating') return
    const key = pageKey
    const name = account.account
    setPageUpdate({ key, state: 'updating' })
    try {
      const response = await fetch('/api/roi/page/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: name, update: true }),
      })
      const data = await response.json().catch(() => ({})) as { result?: RoiOpenResult }
      if (!response.ok || !data.result) throw new Error(apiErrorMessage(data, `Your page could not take the newer ${name} data. Try again in a moment.`))
      setPageUpdate({ key, state: 'done' })
      onPageChanged(data.result)
      if (data.result.status === 'ready') toast.success(`Your page has the newest ${name} data, with the findings written for it.`)
      else toast(`The ${name} report has to be built before your page can take its data.`)
      // The button goes away with the notice: keep focus in the panel.
      if (document.activeElement?.id === 'roi-update-page') dialogRef.current?.focus()
    } catch (error) {
      setPageUpdate({ key, state: 'error', message: error instanceof TypeError ? NETWORK_ERROR : error instanceof Error ? error.message : String(error) })
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50">
      <div aria-hidden="true" onClick={onClose} className="absolute inset-0 bg-graphite-950/30 animate-in fade-in duration-base motion-reduce:animate-none" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="roi-panel-title"
        tabIndex={-1}
        className="absolute inset-y-0 left-0 flex w-[min(420px,92vw)] flex-col border-r bg-background shadow-4 outline-none animate-in slide-in-from-left duration-base ease-out-quart motion-reduce:animate-none"
      >
        <div className="shrink-0 border-b px-5 pb-4 pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[11px] uppercase tracking-wider text-horizon-700">ROI analysis</p>
              <h2 id="roi-panel-title" className="mt-0.5 text-base font-semibold tracking-tight">Filters and settings</h2>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close filters and settings"
              className="-mr-1.5 rounded-md p-1.5 text-muted-foreground transition-colors duration-fast hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <AccountPicker setup={setup} account={account} onAccountChange={onAccountChange} />

          {account && (account.newerData && update?.state !== 'done') && (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-horizon-200 bg-horizon-50/70 px-2.5 py-1.5">
              <Info className="h-3.5 w-3.5 shrink-0 text-horizon-600" aria-hidden />
              <p className="min-w-0 flex-1 text-xs text-horizon-900">Newer data is available for {account.account}.</p>
              <Button
                id="roi-update-page"
                type="button"
                size="sm"
                variant="outline"
                disabled={working || update?.state === 'updating'}
                onClick={() => void updatePage()}
                className="h-7 shrink-0 gap-1.5 px-2 text-xs"
              >
                {update?.state === 'updating' && <Loader2 className="animate-spin" aria-hidden />}
                Update my page
              </Button>
            </div>
          )}
          {update?.state === 'error' && <p role="alert" className="mt-1.5 text-xs text-red-700">{update.message}</p>}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {hasPage && (
            <PanelSection
              id="roi-section-filters"
              title="Report filters"
              count={activeFilters.length}
              countLabel={activeFilters.length === 1 ? 'active filter' : 'active filters'}
              summary={activeFilters.length ? activeFilters.join(' · ') : groups.length ? 'No filters applied' : 'Available once the report has loaded'}
              open={isOpen('filters')}
              onOpenChange={setOpen('filters')}
              actions={activeFilters.length > 0 ? (
                <button type="button" onClick={() => onFiltersChange({ fy: [], fq: [], role: [] })} className={TEXT_BUTTON}>
                  Clear<span className="sr-only"> all report filters</span>
                </button>
              ) : null}
            >
              <ReportFiltersBody groups={groups} filters={filters} filterOptions={filterOptions} onFiltersChange={onFiltersChange} />
            </PanelSection>
          )}

          {account && (
            <PanelSection
              id="roi-section-settings"
              title="Analysis settings"
              summary={describeRunConfig(settings.config).join(' · ')}
              flag={!settings.configValid ? 'Not valid' : settings.configDirty ? 'Changed' : null}
              flagTone={!settings.configValid ? 'risk' : 'info'}
              open={isOpen('settings')}
              onOpenChange={setOpen('settings')}
            >
              <AnalysisSettings settings={settings} />
            </PanelSection>
          )}

          {account && (
            <PanelSection
              id="roi-section-reason"
              title="Reason"
              summary={settings.draft.reason.trim() || 'Not given yet'}
              flag={settings.reasonError ? 'Required' : settings.reasonDirty ? 'Changed' : null}
              flagTone={settings.reasonError ? 'risk' : 'info'}
              open={isOpen('reason')}
              onOpenChange={setOpen('reason')}
            >
              <ReasonField settings={settings} />
            </PanelSection>
          )}

          <PanelSection id="roi-section-history" title="Run history" summary={historySummary} open={isOpen('history')} onOpenChange={setOpen('history')}>
            <RunHistory analyses={analyses} error={historyError} onOpenRun={onOpenRun} compact selectedAccount={account?.account} />
          </PanelSection>

          <PanelSection id="roi-section-data" title="Data source and analyst" summary={dataSummary} open={isOpen('data')} onOpenChange={setOpen('data')}>
            <PageSetupCard setup={setup} onDataSourceChange={onDataSourceChange} />
            {account && account.covers.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">{account.account}'s extracts feed {account.covers.join(', ')}.</p>
            )}
            {setup.canLoadExtracts && (
              <div className="mt-5 border-t pt-4">
                <p className="text-xs font-medium">Value readout</p>
                <p className="mb-2 mt-0.5 text-xs text-muted-foreground">A readout page with its data embedded (Backstory's own) builds {account?.account ?? 'Backstory'}'s report in seconds, with no extracts.</p>
                <ReadoutLoader account={account?.account ?? 'Backstory'} compact onLoaded={(result) => { onPageChanged(result); onExtractsLoaded() }} />
              </div>
            )}
            {setup.canLoadExtracts && (
              <div className="mt-5 border-t pt-4">
                <ExtractLoader setup={setup} onLoaded={onExtractsLoaded} />
              </div>
            )}
          </PanelSection>
        </div>

        {account && (
          <div className="shrink-0 border-t bg-background px-5 pb-4 pt-3">
            {settings.submitError && (
              <p role="alert" className="mb-2.5 flex items-start gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-800">
                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{settings.submitError}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                className="flex-1"
                disabled={working || Boolean(submitting) || unchanged}
                aria-describedby="roi-apply-help"
                onClick={() => void submit(false)}
              >
                {submitting === 'apply' ? <Loader2 className="animate-spin" aria-hidden /> : mode === 'build' ? <Play aria-hidden /> : null}
                {submitting === 'apply' ? 'Starting…' : mode === 'build' ? 'Build the report' : 'Apply'}
              </Button>
              {showRefresh && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={working || Boolean(submitting)}
                  title={`Recomputes the account's data, then writes the findings — about ${aboutDuration(setup.expectedSeconds)}.`}
                  onClick={() => void submit(true)}
                >
                  {submitting === 'refresh' ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
                  Refresh data
                </Button>
              )}
            </div>
            <p id="roi-apply-help" className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              {working && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-horizon-600" aria-hidden />}
              {applyLine({ working, unchanged, mode, setup })}
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * The account, chosen from those with a report or data; with a data flow
 * connected, any account can be typed. One line under it says how fresh the
 * page and its data are.
 */
function AccountPicker({ setup, account, onAccountChange }: { setup: RoiPageSetup; account: RoiPageAccount | null; onAccountChange: (account: string) => void }) {
  const canType = setup.dataSource.kind === 'flow'
  const [typing, setTyping] = useState(false)
  const [typed, setTyped] = useState('')
  const [typedError, setTypedError] = useState<string | null>(null)
  const listed = Boolean(account && setup.accounts.some((entry) => entry.account.trim().toLowerCase() === account.account.trim().toLowerCase()))
  const hintOf = (entry: RoiPageAccount) => (entry.mine ? `On your page · updated ${sinceLabel(entry.mine.updatedAt)}` : entry.report?.ready ? `Report ready · updated ${sinceLabel(entry.report.updatedAt)}` : entry.activeAnalysisId ? 'Being built now' : 'No report yet')
  const options = [
    ...setup.accounts.map((entry) => ({ value: entry.account, label: entry.account, hint: hintOf(entry), ready: Boolean(entry.mine || entry.report?.ready) })),
    ...(account && !listed ? [{ value: account.account, label: account.account, hint: 'No report yet', ready: false }] : []),
  ]
  const showTyped = canType && (typing || options.length === 0)
  const status = account ? accountStatusLine(account, setup.dataSource) : null

  const submitTyped = (event: React.FormEvent) => {
    event.preventDefault()
    const name = typed.trim()
    if (!name) {
      setTypedError('Type the account name, as Backstory names it.')
      return
    }
    setTypedError(null)
    setTyping(false)
    setTyped('')
    onAccountChange(name)
  }

  if (!options.length && !canType) {
    return (
      <p className="mt-4 rounded-md border border-dashed px-3 py-2.5 text-xs text-muted-foreground">
        No account has data loaded yet.{' '}
        {setup.canLoadExtracts
          ? 'Load an account\'s extracts under Data source and analyst.'
          : 'An operator loads an account\'s extracts, or the analyst\'s owner connects a data flow.'}
      </p>
    )
  }

  return (
    <div className="mt-4">
      <label htmlFor={options.length ? 'roi-account' : 'roi-account-typed'} className="mb-1.5 block text-xs font-medium text-muted-foreground">Account</label>
      {options.length > 0 && (
        <AccountSelect
          id="roi-account"
          value={typing ? null : account?.account ?? null}
          options={options}
          placeholder={typing ? 'Another account' : 'Choose an account'}
          onSelect={(next) => {
            setTyping(false)
            setTypedError(null)
            onAccountChange(next)
          }}
          onOther={canType ? () => setTyping(true) : undefined}
        />
      )}
      {showTyped && (
        <form onSubmit={submitTyped} noValidate className={cn('flex gap-2', options.length > 0 && 'mt-2')}>
          <input
            id="roi-account-typed"
            aria-label={options.length ? 'Account name' : undefined}
            value={typed}
            onChange={(event) => { setTyped(event.target.value); setTypedError(null) }}
            onKeyDown={(event) => {
              // Escape leaves the typed entry (when there is a list to go back to), not the panel.
              if (event.key === 'Escape' && options.length > 0) {
                event.preventDefault()
                setTyping(false)
                setTypedError(null)
              }
            }}
            maxLength={200}
            autoFocus={typing}
            autoComplete="off"
            placeholder="The account, as Backstory names it"
            aria-invalid={Boolean(typedError)}
            aria-describedby={typedError ? 'roi-account-typed-error' : undefined}
            className={cn(FIELD, 'h-9 min-w-0 flex-1 px-2.5 text-sm placeholder:text-muted-foreground')}
          />
          <Button type="submit" variant="outline" size="sm" className="h-9 shrink-0">Open</Button>
        </form>
      )}
      {typedError && <p id="roi-account-typed-error" className="mt-1 text-xs text-red-700">{typedError}</p>}
      {status && <p className="mt-1.5 truncate text-xs text-muted-foreground" title={status}>{status}</p>}
    </div>
  )
}

function ReportFiltersBody({ groups, filters, filterOptions, onFiltersChange }: {
  groups: Array<{ key: keyof ReportFilters; label: string }>
  filters: ReportFilters
  filterOptions: ReportFilters | null
  onFiltersChange: (filters: ReportFilters) => void
}) {
  if (!groups.length) return <p className="text-xs text-muted-foreground">The report's filters appear here once it has loaded.</p>
  const toggle = (key: keyof ReportFilters, value: string) => {
    const current = filters[key]
    onFiltersChange({ ...filters, [key]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] })
  }
  return (
    <div className="space-y-2.5">
      {groups.map((group) => (
        <div key={group.key} role="group" aria-labelledby={`roi-filter-${group.key}`} className="grid grid-cols-[4.75rem_minmax(0,1fr)] items-start gap-2">
          <span id={`roi-filter-${group.key}`} className="pt-0.5 text-xs font-medium text-muted-foreground">{group.label}</span>
          <div className="flex flex-wrap gap-1">
            {(filterOptions?.[group.key] ?? []).map((value) => {
              const on = filters[group.key].includes(value)
              return (
                <button key={value} type="button" aria-pressed={on} onClick={() => toggle(group.key, value)} className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}>
                  {value}
                </button>
              )
            })}
          </div>
        </div>
      ))}
      <p className="pt-0.5 text-xs text-muted-foreground">
        Applied as you choose them. Fiscal year and quarter slice the deal and stage views; role narrows the reps behind the activity and adoption views.
      </p>
    </div>
  )
}

function AnalysisSettings({ settings }: { settings: RoiSettings }) {
  const { draft } = settings
  const cohort = ROI_COHORT_OPTIONS.find((option) => option.value === draft.cohort) ?? ROI_COHORT_OPTIONS[0]
  return (
    <div className="space-y-4">
      <div>
        <p id="roi-window-label" className="mb-1.5 text-xs font-medium">Time frame</p>
        <SegmentedControl
          name="roi-window"
          labelledBy="roi-window-label"
          value={draft.windowChoice}
          options={WINDOW_CHOICES}
          onChange={(value) => settings.update({ windowChoice: value })}
        />
        <div aria-hidden="true" className="mt-1 grid grid-cols-4 px-0.5 text-center text-[10px] leading-3 text-muted-foreground">
          {WINDOW_CHOICES.map((option) => <span key={String(option.value)}>{option.value === ROI_IDEAL_WINDOW_MONTHS ? 'Recommended' : ''}</span>)}
        </div>
      </div>

      {settings.isCustom ? (
        <CustomPeriods settings={settings} />
      ) : (
        <div>
          <p id="roi-comparison-label" className="mb-1.5 text-xs font-medium">Compare against</p>
          <SegmentedControl
            name="roi-comparison"
            labelledBy="roi-comparison-label"
            value={draft.comparison}
            options={ROI_COMPARISON_OPTIONS.map((option) => ({ value: option.value, label: COMPARISON_LABEL[option.value], title: option.description }))}
            onChange={(value) => settings.update({ comparison: value })}
          />
        </div>
      )}

      {(settings.preview || settings.warnings.length > 0) && (
        <div className="space-y-1" aria-live="polite">
          {settings.preview && (
            <p
              className="flex items-center gap-1.5 text-xs text-muted-foreground"
              title={settings.isCustom ? 'Custom periods are used exactly as chosen; months without data are left out.' : 'Shown for the latest full months. The windows count back from the newest month in the account\'s data.'}
            >
              <CalendarRange className="h-3.5 w-3.5 shrink-0 text-horizon-600" aria-hidden />
              <span className="min-w-0 truncate">{settings.preview}</span>
            </p>
          )}
          {settings.warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-1.5 text-xs text-amber-800">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{warning}
            </p>
          ))}
        </div>
      )}

      <div>
        <p id="roi-cohort-label" className="mb-1.5 text-xs font-medium">Cohorts</p>
        <SegmentedControl
          name="roi-cohort"
          labelledBy="roi-cohort-label"
          describedBy="roi-cohort-help"
          value={draft.cohort}
          options={ROI_COHORT_OPTIONS.map((option) => ({ value: option.value, label: COHORT_LABEL[option.value], title: option.label }))}
          onChange={(value) => settings.update({ cohort: value })}
        />
        <p id="roi-cohort-help" className="mt-1.5 text-xs text-muted-foreground">{cohort.description}</p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <label htmlFor="roi-fiscal-start" className="text-xs font-medium">
          Fiscal year starts <span className="font-normal text-muted-foreground">(optional)</span>
        </label>
        <select
          id="roi-fiscal-start"
          value={draft.fiscalStart ?? ''}
          onChange={(event) => settings.update({ fiscalStart: event.target.value ? Number(event.target.value) : null })}
          title="Labels fiscal years and quarters, and adds seasonality context."
          className={cn(FIELD, 'h-8 w-36 px-2 text-xs')}
        >
          <option value="">Not set</option>
          {MONTH_NAMES.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
        </select>
      </div>

      {!settings.isDefault && (
        <button type="button" onClick={settings.resetConfig} className={TEXT_BUTTON}>
          <RotateCcw className="h-3 w-3" aria-hidden />Reset to defaults
        </button>
      )}
    </div>
  )
}

function CustomPeriods({ settings }: { settings: RoiSettings }) {
  const { draft, errors, periodMonths } = settings
  const rows = [
    { key: 'baseline' as const, label: 'Baseline', errors: errors.baseline },
    { key: 'observation' as const, label: 'Observation', errors: errors.observation },
  ]
  return (
    <fieldset aria-describedby="roi-periods-help">
      <legend className="mb-1.5 text-xs font-medium">Custom periods</legend>
      <div className="space-y-1.5">
        {rows.map((row) => {
          const invalid = row.errors.length > 0
          const errorId = `roi-${row.key}-error`
          return (
            <div key={row.key}>
              <div className="grid grid-cols-[5.25rem_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{row.label}</span>
                {(['from', 'to'] as const).map((end, index) => (
                  <PeriodSelect
                    key={end}
                    id={`roi-${row.key}-${end}`}
                    label={`${row.label} period ${end === 'from' ? 'start' : 'end'}`}
                    value={draft.custom[row.key][end]}
                    months={periodMonths}
                    invalid={invalid}
                    describedBy={invalid ? errorId : undefined}
                    onChange={(value) => settings.setPeriod(row.key, end, value)}
                    after={index === 0 ? <span aria-hidden="true" className="text-xs text-muted-foreground">to</span> : null}
                  />
                ))}
              </div>
              {invalid && <p id={errorId} className="mt-1 text-xs text-red-700">{row.errors.join(' ')}</p>}
            </div>
          )
        })}
      </div>
      <p id="roi-periods-help" className="mt-1.5 text-xs text-muted-foreground">Each period needs at least 3 months; 6 is ideal. The baseline comes first.</p>
      {errors.periods.map((message) => <p key={message} className="mt-1 text-xs font-medium text-red-700">{message}</p>)}
    </fieldset>
  )
}

function PeriodSelect({ id, label, value, months, invalid, describedBy, onChange, after }: {
  id: string
  label: string
  value: string
  months: string[]
  invalid: boolean
  describedBy?: string
  onChange: (value: string) => void
  /** Drawn after the select, in the same grid row ("to"). */
  after?: React.ReactNode
}) {
  return (
    <>
      <select
        id={id}
        aria-label={label}
        value={value}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        className={cn(FIELD, 'h-8 min-w-0 px-2 text-xs')}
      >
        {months.map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}
      </select>
      {after}
    </>
  )
}

function ReasonField({ settings }: { settings: RoiSettings }) {
  const { draft, reasonError } = settings
  return (
    <div className="space-y-2">
      <div role="group" aria-label="Common reasons" className="flex flex-wrap gap-1">
        {ROI_REASON_PRESETS.map((preset) => {
          const on = hasReasonPreset(draft.reason, preset)
          return (
            <button key={preset} type="button" aria-pressed={on} onClick={() => settings.togglePreset(preset)} className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}>
              {preset}
            </button>
          )
        })}
      </div>
      <label htmlFor="roi-reason" className="sr-only">Reason for running this analysis</label>
      <textarea
        id="roi-reason"
        value={draft.reason}
        onChange={(event) => settings.update({ reason: event.target.value })}
        rows={3}
        maxLength={REASON_MAX_CHARS}
        aria-required="true"
        aria-invalid={reasonError}
        aria-describedby="roi-reason-help"
        placeholder="The occasion, and what the report should make clear. For example: renewal in March; the CFO wants evidence the team uses Backstory."
        className={cn(FIELD, 'block min-h-[84px] resize-y px-3 py-2 text-sm leading-relaxed placeholder:text-muted-foreground')}
      />
      <p id="roi-reason-help" className={cn('text-xs', reasonError ? 'font-medium text-red-700' : 'text-muted-foreground')}>
        {reasonError ? REASON_REQUIRED : 'The analyst reads this to decide what the report emphasises.'}
      </p>
    </div>
  )
}
