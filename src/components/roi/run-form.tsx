'use client'

import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarRange, Database, Loader2, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { indentOnTab } from '@/components/ui/textarea'
import { relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import {
  DEFAULT_RUN_CONFIG,
  MONTH_NAMES,
  ROI_COHORT_OPTIONS,
  ROI_COMPARISON_OPTIONS,
  ROI_REASON_PRESETS,
  ROI_WINDOW_OPTIONS,
  monthLabel,
  roiRunConfigSchema,
  runConfigWarnings,
  type RoiCohortType,
  type RoiComparison,
  type RoiMonthRange,
  type RoiRunConfig,
  type RoiWindowMonths,
} from '@/lib/roi/config'
import { aboutDuration, apiErrorMessage, hasReasonPreset, recentFullMonths, toggleReasonPreset, windowsPreview } from '@/lib/roi/history'
import type { RoiAnalysisView, RoiPageAccount, RoiPageSetup } from '@/lib/roi/types'

type WindowChoice = RoiWindowMonths | 'custom'
type CustomPeriods = { baseline: RoiMonthRange; observation: RoiMonthRange }

const SELECT_CLASS = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition-colors hover:border-graphite-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

const REASON_REQUIRED = "Say why you're running this analysis — it shapes what the report emphasises."

/** The custom periods a fresh form offers: the newest six months against the six before them. */
function defaultCustom(months: string[]): CustomPeriods {
  const at = (back: number) => months[Math.max(0, months.length - back)]
  return { baseline: { from: at(12), to: at(7) }, observation: { from: at(6), to: at(1) } }
}

function accountLine(account: RoiPageAccount, setup: RoiPageSetup): string {
  const covers = account.covers.length ? `Covers ${account.covers.join(', ')}` : 'No extracts loaded yet'
  if (account.loadedAt) return `${covers} · loaded ${relativeTime(account.loadedAt)}`
  if (setup.dataSource.kind === 'flow') return `${covers} · fetched by the ${setup.dataSource.flowName ?? 'data'} flow when the run starts`
  return covers
}

/**
 * The ROI analysis page's run form. Account and reason come first; the
 * configuration sits in its own group with the recommended defaults, a live
 * preview of the months it compares, and plain-English validation.
 */
const OTHER_ACCOUNT = '__other__'

export function RunForm({ setup, onCreated }: { setup: RoiPageSetup; onCreated: (analysis: RoiAnalysisView) => void }) {
  const months = useMemo(() => recentFullMonths(new Date()), [])
  const [account, setAccount] = useState(setup.accounts[0]?.account ?? '')
  const [reason, setReason] = useState('')
  const [windowChoice, setWindowChoice] = useState<WindowChoice>(DEFAULT_RUN_CONFIG.windowMonths)
  const [comparison, setComparison] = useState<RoiComparison>(DEFAULT_RUN_CONFIG.comparison)
  const [custom, setCustom] = useState<CustomPeriods>(() => defaultCustom(months))
  const [cohort, setCohort] = useState<RoiCohortType>(DEFAULT_RUN_CONFIG.cohort)
  const [fiscalStart, setFiscalStart] = useState<number | null>(DEFAULT_RUN_CONFIG.fiscalYearStartMonth ?? null)
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const reasonRef = useRef<HTMLTextAreaElement>(null)
  const periodsRef = useRef<HTMLDivElement>(null)

  const isCustom = windowChoice === 'custom'
  const config: RoiRunConfig = {
    windowMonths: isCustom ? DEFAULT_RUN_CONFIG.windowMonths : windowChoice,
    comparison,
    custom: isCustom ? custom : null,
    cohort,
    fiscalYearStartMonth: fiscalStart,
  }
  const parsed = roiRunConfigSchema.safeParse(config)
  const issues = parsed.success ? [] : parsed.error.issues
  const issuesAt = (path: string) => issues.filter((issue) => issue.path.join('.') === path).map((issue) => issue.message)
  const baselineErrors = issuesAt('custom.baseline')
  const observationErrors = issuesAt('custom.observation')
  const periodErrors = issues.filter((issue) => !['custom.baseline', 'custom.observation'].includes(issue.path.join('.'))).map((issue) => issue.message)
  const warnings = parsed.success ? runConfigWarnings(config) : []
  const preview = parsed.success ? windowsPreview(config, months) : null
  const isDefault = windowChoice === DEFAULT_RUN_CONFIG.windowMonths && comparison === DEFAULT_RUN_CONFIG.comparison && cohort === DEFAULT_RUN_CONFIG.cohort && fiscalStart === (DEFAULT_RUN_CONFIG.fiscalYearStartMonth ?? null)

  // With a data flow connected, any account can run: the flow fetches its data.
  const canTypeAccount = setup.dataSource.kind === 'flow'
  const [otherAccount, setOtherAccount] = useState('')
  const typing = canTypeAccount && (account === OTHER_ACCOUNT || !setup.accounts.length)
  const selected: RoiPageAccount | null = typing
    ? (otherAccount.trim() ? { account: otherAccount.trim(), extracts: [], covers: [], loadedAt: null } : null)
    : setup.accounts.find((candidate) => candidate.account === account) ?? setup.accounts[0] ?? null
  const reasonMissing = !reason.trim()
  const comparisonOption = ROI_COMPARISON_OPTIONS.find((option) => option.value === comparison) ?? ROI_COMPARISON_OPTIONS[0]

  const resetConfig = () => {
    setWindowChoice(DEFAULT_RUN_CONFIG.windowMonths)
    setComparison(DEFAULT_RUN_CONFIG.comparison)
    setCustom(defaultCustom(months))
    setCohort(DEFAULT_RUN_CONFIG.cohort)
    setFiscalStart(DEFAULT_RUN_CONFIG.fiscalYearStartMonth ?? null)
  }

  const setPeriod = (period: keyof CustomPeriods, end: keyof RoiMonthRange, value: string) => {
    setCustom((current) => ({ ...current, [period]: { ...current[period], [end]: value } }))
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting) return
    setAttempted(true)
    if (!selected) return
    setSubmitError(null)
    if (reasonMissing) {
      reasonRef.current?.focus()
      return
    }
    if (!parsed.success) {
      periodsRef.current?.scrollIntoView({ block: 'center' })
      return
    }
    setSubmitting(true)
    try {
      const response = await fetch('/api/roi/analyses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: selected.account, reason: reason.trim(), config: parsed.data }),
      })
      const data = await response.json().catch(() => ({})) as { analysis?: RoiAnalysisView }
      if (!response.ok || !data.analysis) throw new Error(apiErrorMessage(data, 'The analysis could not be started. Try again in a moment.'))
      setAttempted(false)
      onCreated(data.analysis)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  if (!setup.accounts.length && !canTypeAccount) {
    return (
      <div className="rounded-xl border border-dashed border-graphite-200 bg-graphite-50/50 p-6">
        <div className="flex items-center gap-2 text-sm font-semibold"><Database className="h-4 w-4 text-horizon-600" aria-hidden />No account has data loaded yet</div>
        <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
          An operator loads an account's warehouse extracts into the Repository, or an admin connects the data flow under Data source. Accounts appear here once their data is in.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-6 rounded-xl border bg-card p-5 shadow-1 sm:p-6">
      <div>
        <label htmlFor="roi-account" className="text-sm font-medium">Account</label>
        {setup.accounts.length > 0 && (
          <select id="roi-account" value={typing ? OTHER_ACCOUNT : selected?.account ?? ''} onChange={(event) => { setAccount(event.target.value); setSubmitError(null) }} aria-describedby="roi-account-covers" className={cn(SELECT_CLASS, 'mt-1.5')}>
            {setup.accounts.map((option) => <option key={option.account} value={option.account}>{option.account}</option>)}
            {canTypeAccount && <option value={OTHER_ACCOUNT}>Another account…</option>}
          </select>
        )}
        {typing && (
          <input
            id={setup.accounts.length ? 'roi-account-other' : 'roi-account'}
            aria-label={setup.accounts.length ? 'Account name' : undefined}
            value={otherAccount}
            onChange={(event) => { setOtherAccount(event.target.value); setSubmitError(null) }}
            placeholder="The customer account, as Backstory names it"
            maxLength={200}
            className={cn(SELECT_CLASS, 'mt-1.5')}
          />
        )}
        {attempted && typing && !selected && <p className="mt-1.5 text-xs text-red-700">Name the account to analyse.</p>}
        {selected && (
          <p id="roi-account-covers" className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground" title={selected.loadedAt ? new Date(selected.loadedAt).toLocaleString() : undefined}>
            <Database className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{accountLine(selected, setup)}</span>
          </p>
        )}
      </div>

      <div>
        <label htmlFor="roi-reason" className="text-sm font-medium">Reason for running this analysis</label>
        <div role="group" aria-label="Common reasons" className="mt-1.5 flex flex-wrap gap-1.5">
          {ROI_REASON_PRESETS.map((preset) => {
            const on = hasReasonPreset(reason, preset)
            return (
              <button
                key={preset}
                type="button"
                aria-pressed={on}
                onClick={() => setReason((current) => toggleReasonPreset(current, preset))}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  on ? 'border-horizon-600 bg-horizon-600 text-white' : 'border-border bg-background text-foreground hover:bg-muted',
                )}
              >
                {preset}
              </button>
            )
          })}
        </div>
        <textarea
          id="roi-reason"
          ref={reasonRef}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          onKeyDown={indentOnTab}
          rows={3}
          maxLength={2000}
          aria-required="true"
          aria-invalid={attempted && reasonMissing}
          aria-describedby="roi-reason-help"
          placeholder="What is the occasion, and what should the report make clear? For example: renewal in March, and the CFO wants evidence the team uses Backstory."
          className={cn(
            'mt-2 flex w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            attempted && reasonMissing ? 'border-red-500' : 'border-input',
          )}
        />
        <p id="roi-reason-help" className={cn('mt-1.5 text-xs', attempted && reasonMissing ? 'text-red-700' : 'text-muted-foreground')}>
          {attempted && reasonMissing ? REASON_REQUIRED : 'The analyst reads this to decide what the report emphasises.'}
        </p>
      </div>

      <section aria-labelledby="roi-config-heading" className="space-y-5 rounded-lg border bg-muted/30 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 id="roi-config-heading" className="text-sm font-semibold">Configuration</h2>
            <p className="text-xs text-muted-foreground">The defaults suit most accounts.</p>
          </div>
          {!isDefault && (
            <button type="button" onClick={resetConfig} className="inline-flex items-center gap-1 rounded text-xs font-medium text-horizon-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <RotateCcw className="h-3 w-3" aria-hidden />Reset to defaults
            </button>
          )}
        </div>

        <fieldset>
          <legend className="text-sm font-medium">Analysis time frame</legend>
          <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[...ROI_WINDOW_OPTIONS.map((option) => ({ value: option.value as WindowChoice, label: option.label, hint: option.hint })), { value: 'custom' as WindowChoice, label: 'Custom periods', hint: 'Pick the months yourself' }].map((option) => {
              const checked = windowChoice === option.value
              const id = `roi-window-${option.value}`
              return (
                <label
                  key={option.value}
                  htmlFor={id}
                  className={cn(
                    'flex cursor-pointer flex-col rounded-lg border bg-background px-3 py-2 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                    checked ? 'border-horizon-500 ring-1 ring-horizon-500' : 'border-border hover:border-graphite-300',
                  )}
                >
                  <input id={id} type="radio" name="roi-window" value={String(option.value)} checked={checked} onChange={() => setWindowChoice(option.value)} className="sr-only" />
                  <span className={cn('font-medium', checked && 'text-horizon-700')}>{option.label}</span>
                  <span className="text-xs text-muted-foreground">{option.hint ?? '\u00a0'}</span>
                </label>
              )
            })}
          </div>
        </fieldset>

        {!isCustom ? (
          <fieldset>
            <legend className="text-sm font-medium">Compare against</legend>
            <div className="mt-1.5 flex flex-col rounded-lg border bg-background p-1 sm:inline-flex sm:flex-row">
              {ROI_COMPARISON_OPTIONS.map((option) => {
                const checked = comparison === option.value
                const id = `roi-comparison-${option.value}`
                return (
                  <label
                    key={option.value}
                    htmlFor={id}
                    className={cn(
                      'cursor-pointer rounded-md px-3 py-1.5 text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                      checked ? 'bg-horizon-600 text-white shadow-1' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <input id={id} type="radio" name="roi-comparison" value={option.value} checked={checked} onChange={() => setComparison(option.value)} className="sr-only" />
                    {option.label}
                  </label>
                )
              })}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{comparisonOption.description}</p>
          </fieldset>
        ) : (
          <div ref={periodsRef} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <PeriodPicker name="baseline" legend="Baseline period" range={custom.baseline} months={months} errors={baselineErrors} onChange={(end, value) => setPeriod('baseline', end, value)} />
              <PeriodPicker name="observation" legend="Observation period" range={custom.observation} months={months} errors={observationErrors} onChange={(end, value) => setPeriod('observation', end, value)} />
            </div>
            <p className="text-xs text-muted-foreground">Each period needs at least 3 months; 6 is ideal. The baseline comes first.</p>
            {periodErrors.map((message) => <p key={message} role="alert" className="text-xs font-medium text-red-700">{message}</p>)}
          </div>
        )}

        {preview && (
          <div className="flex items-start gap-2 rounded-md border border-horizon-100 bg-horizon-50/60 px-3 py-2 text-sm" aria-live="polite">
            <CalendarRange className="mt-0.5 h-4 w-4 shrink-0 text-horizon-600" aria-hidden />
            <div>
              <p className="font-medium text-foreground">{preview}</p>
              <p className="text-xs text-muted-foreground">
                {isCustom
                  ? 'Custom periods are used exactly as chosen; months the account has no data for are left out.'
                  : 'Shown for the latest full months. The windows count back from the newest month in the account\'s data, so the exact months can differ.'}
              </p>
            </div>
          </div>
        )}

        {warnings.length > 0 && (
          <ul className="space-y-1">
            {warnings.map((warning) => (
              <li key={warning} className="flex items-start gap-1.5 text-xs text-amber-800">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />{warning}
              </li>
            ))}
          </ul>
        )}

        <fieldset>
          <legend className="text-sm font-medium">Cohort type</legend>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {ROI_COHORT_OPTIONS.map((option) => {
              const checked = cohort === option.value
              const id = `roi-cohort-${option.value}`
              return (
                <label
                  key={option.value}
                  htmlFor={id}
                  className={cn(
                    'flex cursor-pointer items-start gap-2.5 rounded-lg border bg-background p-3 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                    checked ? 'border-horizon-500 ring-1 ring-horizon-500' : 'border-border hover:border-graphite-300',
                  )}
                >
                  <input id={id} type="radio" name="roi-cohort" value={option.value} checked={checked} onChange={() => setCohort(option.value)} className="sr-only" />
                  <span aria-hidden className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border', checked ? 'border-horizon-600' : 'border-graphite-300')}>
                    {checked && <span className="h-2 w-2 rounded-full bg-horizon-600" />}
                  </span>
                  <span>
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.description}</span>
                  </span>
                </label>
              )
            })}
          </div>
        </fieldset>

        <div className="max-w-xs">
          <label htmlFor="roi-fiscal-start" className="text-sm font-medium">Fiscal year start <span className="font-normal text-muted-foreground">(optional)</span></label>
          <select
            id="roi-fiscal-start"
            value={fiscalStart ?? ''}
            onChange={(event) => setFiscalStart(event.target.value ? Number(event.target.value) : null)}
            aria-describedby="roi-fiscal-help"
            className={cn(SELECT_CLASS, 'mt-1.5')}
          >
            <option value="">Not set</option>
            {MONTH_NAMES.map((name, index) => <option key={name} value={index + 1}>{name}</option>)}
          </select>
          <p id="roi-fiscal-help" className="mt-1.5 text-xs text-muted-foreground">Used for fiscal-year and quarter views and seasonality context.</p>
        </div>
      </section>

      {submitError && <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{submitError}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Takes about {aboutDuration(setup.expectedSeconds)}. You can leave the page while it runs.</p>
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
          {submitting ? 'Starting…' : 'Run analysis'}
        </Button>
      </div>
    </form>
  )
}

function PeriodPicker({ name, legend, range, months, errors, onChange }: {
  name: string
  legend: string
  range: RoiMonthRange
  months: string[]
  errors: string[]
  onChange: (end: keyof RoiMonthRange, value: string) => void
}) {
  const errorId = `roi-${name}-error`
  return (
    <fieldset className="rounded-lg border bg-background p-3" aria-describedby={errors.length ? errorId : undefined}>
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <div className="grid grid-cols-2 gap-2">
        {(['from', 'to'] as const).map((end) => {
          const id = `roi-${name}-${end}`
          return (
            <div key={end}>
              <label htmlFor={id} className="text-xs text-muted-foreground">{end === 'from' ? 'From' : 'To'}</label>
              <select id={id} value={range[end]} onChange={(event) => onChange(end, event.target.value)} aria-invalid={errors.length > 0} className={cn(SELECT_CLASS, 'mt-1 h-9', errors.length > 0 && 'border-red-500')}>
                {months.map((month) => <option key={month} value={month}>{monthLabel(month)}</option>)}
              </select>
            </div>
          )
        })}
      </div>
      {errors.length > 0 && <p id={errorId} role="alert" className="mt-2 text-xs font-medium text-red-700">{errors.join(' ')}</p>}
    </fieldset>
  )
}
