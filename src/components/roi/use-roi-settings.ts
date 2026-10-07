'use client'

import { useMemo, useState } from 'react'
import {
  DEFAULT_RUN_CONFIG,
  roiRunConfigSchema,
  runConfigWarnings,
  type RoiCohortType,
  type RoiComparison,
  type RoiMonthRange,
  type RoiRunConfig,
  type RoiWindowMonths,
} from '@/lib/roi/config'
import {
  apiErrorMessage,
  applyModeFor,
  recentFullMonths,
  sameRunConfig,
  settingsStartFor,
  toggleReasonPreset,
  windowsPreview,
  type RoiApplyMode,
} from '@/lib/roi/history'
import type { RoiAnalysisView, RoiPageAccount } from '@/lib/roi/types'

export type RoiWindowChoice = RoiWindowMonths | 'custom'
export type RoiCustomPeriods = { baseline: RoiMonthRange; observation: RoiMonthRange }
/** What stops a submit: the analysis settings (custom periods), or the missing reason. */
export type RoiSettingsProblem = 'config' | 'reason'

export const REASON_REQUIRED = "Say why you're running this analysis — it shapes what the report emphasises."
export const REASON_MAX_CHARS = 2000
const NETWORK_ERROR = 'The page could not reach the server. Check your connection and try again.'

export type RoiSettingsDraft = {
  reason: string
  windowChoice: RoiWindowChoice
  comparison: RoiComparison
  custom: RoiCustomPeriods
  cohort: RoiCohortType
  fiscalStart: number | null
}

/** The custom periods a fresh form offers: the newest six months against the six before them. */
function defaultCustom(months: string[]): RoiCustomPeriods {
  const at = (back: number) => months[Math.max(0, months.length - back)]
  return { baseline: { from: at(12), to: at(7) }, observation: { from: at(6), to: at(1) } }
}

function draftFrom(start: { config: RoiRunConfig; reason: string }, months: string[]): RoiSettingsDraft {
  const { config } = start
  return {
    reason: start.reason,
    windowChoice: config.custom ? 'custom' : config.windowMonths,
    comparison: config.comparison,
    custom: config.custom ?? defaultCustom(months),
    cohort: config.cohort,
    fiscalStart: config.fiscalYearStartMonth ?? null,
  }
}

function configOf(draft: RoiSettingsDraft): RoiRunConfig {
  const choice = draft.windowChoice
  return {
    windowMonths: choice === 'custom' ? DEFAULT_RUN_CONFIG.windowMonths : choice,
    comparison: draft.comparison,
    custom: choice === 'custom' ? draft.custom : null,
    cohort: draft.cohort,
    fiscalYearStartMonth: draft.fiscalStart,
  }
}

function isDirty(draft: RoiSettingsDraft, baseline: { config: RoiRunConfig; reason: string }): boolean {
  return !sameRunConfig(configOf(draft), baseline.config) || draft.reason.trim() !== baseline.reason.trim()
}

/** Which account the form is for, and which version of its settings it started from. */
function sourceKeyOf(account: RoiPageAccount | null): { account: string; source: string } {
  if (!account) return { account: '', source: '' }
  const source = account.mine
    ? `mine:${account.mine.versionId}`
    : account.report
      ? `report:${account.report.versionId ?? account.report.updatedAt}`
      : 'new'
  return { account: account.account.trim().toLowerCase(), source }
}

/**
 * The side panel's analysis form, lifted out of the sections that draw it so
 * the panel's sticky footer can submit it. It opens on the account's current
 * settings (this person's page, else the account's report, else the
 * defaults) and starts again when the account changes. When a new version of
 * the same account's settings lands, a draft with changes is kept — only what
 * it is compared against moves.
 */
export function useRoiSettings({ account, busy, onStarted }: {
  account: RoiPageAccount | null
  /** A run is updating this page: nothing may be submitted. */
  busy: boolean
  onStarted: (analysis: RoiAnalysisView) => void
}) {
  const months = useMemo(() => recentFullMonths(new Date()), [])
  const key = sourceKeyOf(account)
  const [form, setForm] = useState(() => {
    const baseline = settingsStartFor(account)
    return { ...key, baseline, draft: draftFrom(baseline, months) }
  })
  const [attempted, setAttempted] = useState(false)
  const [submitting, setSubmitting] = useState<'apply' | 'refresh' | null>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)

  if (form.account !== key.account || form.source !== key.source) {
    const baseline = settingsStartFor(account)
    const keepDraft = form.account === key.account && isDirty(form.draft, form.baseline)
    setForm({ ...key, baseline, draft: keepDraft ? form.draft : draftFrom(baseline, months) })
    // A new version makes an earlier submit error stale; another account starts clean.
    setSubmitError(null)
    if (form.account !== key.account) setAttempted(false)
  }

  const { draft, baseline } = form
  const isCustom = draft.windowChoice === 'custom'
  const config = configOf(draft)
  const parsed = roiRunConfigSchema.safeParse(config)
  const issues = parsed.success ? [] : parsed.error.issues
  const messagesAt = (path: string) => issues.filter((issue) => issue.path.join('.') === path).map((issue) => issue.message)
  const errors = {
    baseline: messagesAt('custom.baseline'),
    observation: messagesAt('custom.observation'),
    periods: issues.filter((issue) => !['custom.baseline', 'custom.observation'].includes(issue.path.join('.'))).map((issue) => issue.message),
  }
  const invalidFieldId = errors.baseline.length
    ? 'roi-baseline-from'
    : errors.observation.length
      ? 'roi-observation-from'
      : errors.periods.length
        ? 'roi-baseline-to'
        : null
  // The month pickers offer the recent full months, plus any month a stored
  // configuration already uses, so an older choice still shows as chosen.
  const periodMonths = useMemo(
    () => [...new Set([...months, draft.custom.baseline.from, draft.custom.baseline.to, draft.custom.observation.from, draft.custom.observation.to])].sort(),
    [months, draft.custom],
  )
  const reasonMissing = !draft.reason.trim()
  const mode: RoiApplyMode | null = account ? applyModeFor(account) : null

  const update = (patch: Partial<RoiSettingsDraft>) => setForm((current) => ({ ...current, draft: { ...current.draft, ...patch } }))

  const setPeriod = (period: keyof RoiCustomPeriods, end: keyof RoiMonthRange, value: string) =>
    setForm((current) => ({
      ...current,
      draft: { ...current.draft, custom: { ...current.draft.custom, [period]: { ...current.draft.custom[period], [end]: value } } },
    }))

  const togglePreset = (preset: string) =>
    setForm((current) => ({ ...current, draft: { ...current.draft, reason: toggleReasonPreset(current.draft.reason, preset) } }))

  const resetConfig = () => update({
    windowChoice: DEFAULT_RUN_CONFIG.windowMonths,
    comparison: DEFAULT_RUN_CONFIG.comparison,
    custom: defaultCustom(months),
    cohort: DEFAULT_RUN_CONFIG.cohort,
    fiscalStart: DEFAULT_RUN_CONFIG.fiscalYearStartMonth ?? null,
  })

  /**
   * Apply (refresh false: the server rewrites the findings when it can, or
   * rebuilds) or Refresh data (refresh true: the data is recomputed). Returns
   * what stopped it, in the order the panel shows them; empty once sent.
   */
  const submit = async (refresh: boolean): Promise<RoiSettingsProblem[]> => {
    if (!account || submitting || busy) return []
    setAttempted(true)
    setSubmitError(null)
    const problems: RoiSettingsProblem[] = []
    if (!parsed.success) problems.push('config')
    if (reasonMissing) problems.push('reason')
    if (problems.length || !parsed.success) return problems
    setSubmitting(refresh ? 'refresh' : 'apply')
    try {
      const response = await fetch('/api/roi/analyses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: account.account, reason: draft.reason.trim(), config: parsed.data, refresh }),
      })
      const data = await response.json().catch(() => ({})) as { analysis?: RoiAnalysisView }
      if (!response.ok || !data.analysis) throw new Error(apiErrorMessage(data, 'Your page could not be updated. Try again in a moment.'))
      setAttempted(false)
      onStarted(data.analysis)
    } catch (error) {
      setSubmitError(error instanceof TypeError ? NETWORK_ERROR : error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(null)
    }
    return []
  }

  return {
    /** The recent full months, oldest first (the windows preview reads them). */
    months,
    /** The months the custom period pickers offer. */
    periodMonths,
    draft,
    /** The settings and reason the form started from (what "changed" is measured against). */
    baseline,
    config,
    isCustom,
    configValid: parsed.success,
    errors,
    /** The control to focus when the settings stop a submit. */
    invalidFieldId,
    warnings: parsed.success ? runConfigWarnings(config) : [],
    preview: parsed.success ? windowsPreview(config, months) : null,
    isDefault: sameRunConfig(config, DEFAULT_RUN_CONFIG),
    configDirty: !sameRunConfig(config, baseline.config),
    reasonDirty: draft.reason.trim() !== baseline.reason.trim(),
    reasonMissing,
    /** The reason is missing and a submit was tried. */
    reasonError: attempted && reasonMissing,
    mode,
    submitting,
    submitError,
    update,
    setPeriod,
    togglePreset,
    resetConfig,
    submit,
  }
}

export type RoiSettings = ReturnType<typeof useRoiSettings>
