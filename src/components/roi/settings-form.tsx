'use client'

import { useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarRange, Loader2, Play, RefreshCw, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { indentOnTab } from '@/components/ui/textarea'
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

/**
 * The analysis settings for one account's report, in the ROI page's side
 * panel. They open on the report's current settings; Apply makes them the
 * report's next version — the findings rewritten for them on the report's
 * data, or the report built when it has none yet. Refresh data recomputes
 * the data too (new extracts, or the data flow).
 */
export function SettingsForm({ setup, account, onStarted, busy }: {
  setup: RoiPageSetup
  /** The account the settings are for (typed accounts arrive without extracts or a report). */
  account: RoiPageAccount
  onStarted: (analysis: RoiAnalysisView) => void
  /** A run is updating this report already. */
  busy: boolean
}) {
  const months = useMemo(() => recentFullMonths(new Date()), [])
  const report = account.report
  const start: RoiRunConfig = report?.config ?? DEFAULT_RUN_CONFIG
  const [reason, setReason] = useState(report?.reason ?? '')
  const [windowChoice, setWindowChoice] = useState<WindowChoice>(start.custom ? 'custom' : start.windowMonths)
  const [comparison, setComparison] = useState<RoiComparison>(start.comparison)
  const [custom, setCustom] = useState<CustomPeriods>(() => start.custom ?? defaultCustom(months))
  const [cohort, setCohort] = useState<RoiCohortType>(start.cohort)
  const [fiscalStart, setFiscalStart] = useState<number | null>(start.fiscalYearStartMonth ?? null)
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState<'apply' | 'refresh' | null>(null)
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

  const submit = async (refresh: boolean) => {
    if (submitting || busy) return
    setAttempted(true)
    setSubmitError(null)
    if (reasonMissing) {
      reasonRef.current?.focus()
      return
    }
    if (!parsed.success) {
      periodsRef.current?.scrollIntoView({ block: 'center' })
      return
    }
    setSubmitting(refresh ? 'refresh' : 'apply')
    try {
      const response = await fetch('/api/roi/analyses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: account.account, reason: reason.trim(), config: parsed.data, refresh }),
      })
      const data = await response.json().catch(() => ({})) as { analysis?: RoiAnalysisView }
      if (!response.ok || !data.analysis) throw new Error(apiErrorMessage(data, 'The report could not be updated. Try again in a moment.'))
      setAttempted(false)
      onStarted(data.analysis)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(null)
    }
  }

  const willRewrite = Boolean(report?.factsCurrent)
  return (
    <form onSubmit={(event) => { event.preventDefault(); void submit(false) }} noValidate className="space-y-5">
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

      <section aria-labelledby="roi-config-heading" className="space-y-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h3 id="roi-config-heading" className="text-sm font-semibold">Analysis settings</h3>
            <p className="text-xs text-muted-foreground">{report ? 'These are the report\'s current settings.' : 'The defaults suit most accounts.'}</p>
          </div>
          {!isDefault && (
            <button type="button" onClick={resetConfig} className="inline-flex items-center gap-1 rounded text-xs font-medium text-horizon-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <RotateCcw className="h-3 w-3" aria-hidden />Reset to defaults
            </button>
          )}
        </div>

        <fieldset>
          <legend className="text-sm font-medium">Analysis time frame</legend>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
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
            <div className="grid gap-3">
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
          <div className="mt-1.5 grid gap-2">
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

      <div className="space-y-2 border-t pt-4">
        <p className="text-xs text-muted-foreground">
          {busy
            ? 'This report is being updated now. Apply again once the new version is in.'
            : willRewrite
              ? `Apply rewrites the findings for these settings on the report's data — about ${aboutDuration(setup.reconfigureSeconds)}. The report keeps its earlier versions.`
              : report
                ? `Apply rebuilds this report from the account's data — about ${aboutDuration(setup.expectedSeconds)}. The report keeps its earlier versions.`
                : `Builds ${account.account}'s report — about ${aboutDuration(setup.expectedSeconds)}. You can leave the page while it runs.`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={Boolean(submitting) || busy}>
            {submitting === 'apply' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
            {submitting === 'apply' ? 'Starting…' : report ? 'Apply to the report' : 'Build the report'}
          </Button>
          {report && account.canRefresh && (
            <Button type="button" variant="outline" disabled={Boolean(submitting) || busy} onClick={() => void submit(true)}>
              {submitting === 'refresh' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
              Refresh data
            </Button>
          )}
        </div>
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
