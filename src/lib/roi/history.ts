import { monthKey, resolveWindows, type RoiRunConfig } from './config'
import type { RoiAnalysisView, RoiRunPhase } from './types'

/**
 * The ROI analysis page's pure logic: run history folders, the run-over-run
 * comparison, the progress stepper and the small formatting the page shows.
 * A leaf module (config + types only), so the client components and the
 * tests import it freely.
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
