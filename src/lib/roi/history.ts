import { DEFAULT_RUN_CONFIG, monthKey, resolveWindows, type RoiRunConfig } from './config'
import { relativeTime } from '../relative-time'
import { ROI_SOURCE_KINDS, ROI_SOURCE_LABEL, type RoiSourceKind } from './source-kinds'
import type { RoiAnalysisView, RoiPageAccount, RoiPageSetup, RoiRunPhase } from './types'

/**
 * The ROI analysis page's pure logic: run history folders, the run-over-run
 * comparison, the progress stepper and the small formatting the page shows.
 * A leaf module (config, types and the pure relative-time formatter; the
 * sources import is type-only), so the client components and the tests
 * import it freely.
 */

/** A run is settled once it can no longer change: the report is ready, or it failed. */
export function isRunSettled(phase: RoiRunPhase): boolean {
  return phase === 'ready' || phase === 'failed'
}

function timeOf(iso: string | null | undefined): number {
  const at = iso ? Date.parse(iso) : NaN
  return Number.isFinite(at) ? at : 0
}

function newestFirst(a: RoiAnalysisView, b: RoiAnalysisView): number {
  return timeOf(b.createdAt) - timeOf(a.createdAt)
}

export type RoiAccountFolder = {
  /** The account as its newest run spells it. */
  account: string
  /** Newest first. */
  runs: RoiAnalysisView[]
  lastRunAt: string
  /** Runs whose report is ready. */
  completed: number
}

/**
 * Run history as one folder per account, the most recently run first. Accounts
 * that differ only in case or surrounding spaces share a folder. `query`
 * keeps the folders whose account name contains it, ignoring case.
 */
export function groupRunsByAccount(analyses: RoiAnalysisView[], query = ''): RoiAccountFolder[] {
  const needle = query.trim().toLowerCase()
  const byKey = new Map<string, RoiAnalysisView[]>()
  for (const analysis of analyses) {
    const key = analysis.account.trim().toLowerCase()
    if (!key) continue
    const runs = byKey.get(key)
    if (runs) runs.push(analysis)
    else byKey.set(key, [analysis])
  }
  const folders: RoiAccountFolder[] = []
  for (const [key, runs] of byKey) {
    if (needle && !key.includes(needle)) continue
    const sorted = [...runs].sort(newestFirst)
    folders.push({
      account: sorted[0].account.trim(),
      runs: sorted,
      lastRunAt: sorted[0].createdAt,
      completed: sorted.filter((run) => run.phase === 'ready').length,
    })
  }
  return folders.sort((a, b) => timeOf(b.lastRunAt) - timeOf(a.lastRunAt) || a.account.localeCompare(b.account))
}

export type RoiRunComparison = {
  /** The compared runs, oldest first, so a refresh reads left to right. */
  runs: Array<{ id: string; createdAt: string; reason: string; artifactId: string | null }>
  /** One row per headline number; a cell is null where that run did not record it. */
  rows: Array<{ key: string; label: string; cells: Array<string | null> }>
}

/**
 * The completed runs of an account side by side: columns are the runs by
 * date, rows the headline numbers. Rows follow the newest run's order and
 * labels; numbers only older runs recorded come after.
 */
export function compareRuns(analyses: RoiAnalysisView[]): RoiRunComparison {
  const runs = analyses.filter((run) => run.phase === 'ready').sort((a, b) => timeOf(a.createdAt) - timeOf(b.createdAt))
  const labels = new Map<string, string>()
  for (const run of [...runs].reverse()) {
    for (const kpi of run.kpis) if (!labels.has(kpi.key)) labels.set(kpi.key, kpi.label)
  }
  return {
    runs: runs.map((run) => ({ id: run.id, createdAt: run.createdAt, reason: run.reason, artifactId: run.artifactId })),
    rows: [...labels].map(([key, label]) => ({
      key,
      label,
      cells: runs.map((run) => run.kpis.find((kpi) => kpi.key === key)?.display ?? null),
    })),
  }
}

/** Replace a run in the list by id, or put it first when it is new. */
export function upsertRun(analyses: RoiAnalysisView[], analysis: RoiAnalysisView): RoiAnalysisView[] {
  const at = analyses.findIndex((candidate) => candidate.id === analysis.id)
  if (at === -1) return [analysis, ...analyses]
  const next = [...analyses]
  next[at] = analysis
  return next
}

export const ROI_RUN_STEPS: Array<{ phase: Exclude<RoiRunPhase, 'queued' | 'ready' | 'failed'>; label: string }> = [
  { phase: 'fetching', label: 'Fetching data' },
  { phase: 'computing', label: 'Computing the analysis' },
  { phase: 'writing', label: 'Writing the findings' },
  { phase: 'building', label: 'Building the report' },
]

export type RoiStepState = 'done' | 'active' | 'pending'

/** Where each step of the stepper stands for a phase. A failed run has no active step. */
export function stepStates(phase: RoiRunPhase): RoiStepState[] {
  if (phase === 'ready') return ROI_RUN_STEPS.map(() => 'done')
  const at = ROI_RUN_STEPS.findIndex((step) => step.phase === phase)
  return ROI_RUN_STEPS.map((_, index) => (at === -1 ? 'pending' : index < at ? 'done' : index === at ? 'active' : 'pending'))
}

export type RoiRunStatus = { label: string; tone: 'good' | 'risk' | 'info' }

export function runStatus(phase: RoiRunPhase): RoiRunStatus {
  switch (phase) {
    case 'ready': return { label: 'Ready', tone: 'good' }
    case 'failed': return { label: 'Failed', tone: 'risk' }
    case 'queued': return { label: 'Queued', tone: 'info' }
    default: return { label: 'Running', tone: 'info' }
  }
}

/** The last `count` full months, oldest first, ending with the month before `now`. */
export function recentFullMonths(now: Date, count = 24): string[] {
  const last = now.getFullYear() * 12 + now.getMonth() - 1
  return Array.from({ length: count }, (_, index) => monthKey(last - count + 1 + index))
}

/** The windows a configuration picks, in words: "Compares Apr 2026 – Sep 2026 with Oct 2025 – Mar 2026". */
export function windowsPreview(config: RoiRunConfig, months: string[]): string {
  const windows = resolveWindows(months, config)
  if (!windows.observation.length || !windows.baseline.length) return 'The chosen months fall outside the data this page can reach.'
  return `Compares ${windows.observationLabel} with ${windows.baselineLabel}`
}

/** A typical duration in words: 90 → "a minute and a half". */
export function aboutDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 50) return `${Math.max(5, Math.round(s / 5) * 5)} seconds`
  if (s < 75) return 'a minute'
  if (s < 105) return 'a minute and a half'
  return `${Math.round(s / 60)} minutes`
}

/** Elapsed time as a clock: 42 → "0:42", 3725 → "62:05". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * The message an API error carries: `{ error: "..." }` or
 * `{ error: { message: "..." } }`, else the fallback.
 */
export function apiErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback
  const error = (data as { error?: unknown }).error
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return fallback
}

/**
 * A reason preset toggled in the reason text: added (comma-separated) when
 * absent, removed when it is one of the comma-separated parts.
 */
export function toggleReasonPreset(reason: string, preset: string): string {
  const parts = reason.split(',').map((part) => part.trim()).filter(Boolean)
  const at = parts.findIndex((part) => part.toLowerCase() === preset.toLowerCase())
  if (at === -1) return [...parts, preset].join(', ')
  parts.splice(at, 1)
  return parts.join(', ')
}

export function hasReasonPreset(reason: string, preset: string): boolean {
  return reason.split(',').some((part) => part.trim().toLowerCase() === preset.toLowerCase())
}

/**
 * The settings the side panel opens on for an account: this person's page,
 * else the account's report, else the defaults (with no reason).
 */
export function settingsStartFor(account: Pick<RoiPageAccount, 'mine' | 'report'> | null): { config: RoiRunConfig; reason: string } {
  const source = account?.mine ?? account?.report ?? null
  return { config: { ...DEFAULT_RUN_CONFIG, ...(source?.config ?? {}) }, reason: source?.reason ?? '' }
}

/**
 * Two configurations pick the same analysis. Explicit periods replace the
 * counted-back window, so with them the window length and comparison do not count.
 */
export function sameRunConfig(a: RoiRunConfig, b: RoiRunConfig): boolean {
  if (a.cohort !== b.cohort || (a.fiscalYearStartMonth ?? null) !== (b.fiscalYearStartMonth ?? null)) return false
  if (a.custom || b.custom) {
    if (!a.custom || !b.custom) return false
    const { baseline: ab, observation: ao } = a.custom
    const { baseline: bb, observation: bo } = b.custom
    return ab.from === bb.from && ab.to === bb.to && ao.from === bo.from && ao.to === bo.to
  }
  return a.windowMonths === b.windowMonths && a.comparison === b.comparison
}

/**
 * What Apply does for an account: `rewrite` the findings on this person's
 * page's data (it is current), `rebuild` from the account's data (a page or
 * report exists, but not on current data), or `build` its first report.
 */
export type RoiApplyMode = 'rewrite' | 'rebuild' | 'build'

export function applyModeFor(account: Pick<RoiPageAccount, 'mine' | 'report'>): RoiApplyMode {
  if (account.mine?.factsCurrent) return 'rewrite'
  return account.mine || account.report ? 'rebuild' : 'build'
}

/** "5m ago" and "just now" as they are; a date (once relative time falls back to one) as "on Oct 1". */
export function sinceLabel(iso: string, now: Date = new Date()): string {
  const relative = relativeTime(iso, now)
  return relative === 'just now' || relative.endsWith(' ago') ? relative : `on ${relative}`
}

/** One account's runs (spelled any way), newest first. */
export function runsOfAccount(analyses: RoiAnalysisView[], account: string): RoiAnalysisView[] {
  const key = account.trim().toLowerCase()
  return analyses.filter((run) => run.account.trim().toLowerCase() === key).sort(newestFirst)
}

/** Run history in a line, for the panel's collapsed section: "4 runs · last run 5m ago". */
export function runsSummary(runs: RoiAnalysisView[], now: Date = new Date()): string {
  if (!runs.length) return 'No runs yet'
  const latest = runs.reduce((newest, run) => (timeOf(run.createdAt) > timeOf(newest.createdAt) ? run : newest))
  return `${runs.length} ${runs.length === 1 ? 'run' : 'runs'} · last run ${sinceLabel(latest.createdAt, now)}`
}

/** Where an account stands, in one line: "Your page updated 5m ago · data loaded 2d ago". */
export function accountStatusLine(
  account: Pick<RoiPageAccount, 'mine' | 'report' | 'loadedAt' | 'extracts'>,
  dataSource: RoiPageSetup['dataSource'],
  now: Date = new Date(),
): string {
  const parts: string[] = []
  if (account.mine) parts.push(`Your page updated ${sinceLabel(account.mine.updatedAt, now)}`)
  else if (account.report?.ready) parts.push(`Report updated ${sinceLabel(account.report.updatedAt, now)}`)
  else if (account.report) parts.push('Report being built')
  else parts.push('No report yet')
  if (account.loadedAt) parts.push(`data loaded ${sinceLabel(account.loadedAt, now)}`)
  else if (dataSource.kind === 'flow') parts.push(`data from the ${dataSource.flowName ?? 'data'} flow`)
  else if (!account.extracts.length) parts.push('no data loaded')
  return parts.join(' · ')
}

/** The extracts an operator loads from the page, with their labels. */
export const ROI_EXTRACT_KINDS: ReadonlyArray<{ kind: RoiSourceKind; label: string }> = ROI_SOURCE_KINDS.map((kind) => ({ kind, label: ROI_SOURCE_LABEL[kind] }))

/** The Repository description of a loaded extract (as the operator CLI writes it). */
export function extractDescription(kind: RoiSourceKind, account: string, at: Date = new Date()): string {
  return `${ROI_SOURCE_LABEL[kind]} for ${account.trim()} — ROI analysis extract, loaded ${at.toISOString().slice(0, 10)}.`
}

/** Each name once, ignoring case and surrounding spaces; the first spelling wins. Blank names are dropped. */
export function uniqueAccountNames(names: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const trimmed = name?.trim()
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue
    seen.add(trimmed.toLowerCase())
    out.push(trimmed)
  }
  return out
}

/**
 * An account name as typed, in the spelling the page already uses for it:
 * extracts are grouped by their exact account tag, so "hp" must land on "HP".
 */
export function canonicalAccountName(typed: string, known: string[]): string {
  const trimmed = typed.trim()
  return known.find((name) => name.trim().toLowerCase() === trimmed.toLowerCase())?.trim() ?? trimmed
}
