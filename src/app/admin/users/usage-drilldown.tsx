'use client'

/**
 * Lazy per-user model/surface usage, behind the operator console's detail
 * panel.
 *
 * Fetched only when a row is selected (see the `useEffect` below, keyed on
 * `userId`) — never eagerly for the whole table. /api/admin/users already
 * pays for the cross-tenant listing query; a per-row breakdown for all 200
 * accounts on the page would multiply that by 200 for detail nobody asked to
 * see yet.
 */

import { useEffect, useState } from 'react'

type Rollup = {
  calls: number
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number
}
type ModelRow = Rollup & { provider: string; model: string }
type SurfaceRow = Rollup & { surface: string }
type UsageReport = {
  days: number
  dataSince: string | null
  totals: Rollup
  byModel: ModelRow[]
  bySurface: SurfaceRow[]
  hasUnattributedOrgUsage: boolean
}

const usd = (value: number) => (value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : '<$0.01')

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

/** 'agent_turn' -> 'Agent turn', 'flow_ai' -> 'Flow AI step', etc. */
const SURFACE_LABEL: Record<string, string> = {
  agent_turn: 'Agent runs',
  flow_ai: 'Flow AI steps',
  structured: 'Structured extraction',
  headline: 'Run headlines',
  embedding: 'Knowledge embeddings',
  eval_judge: 'Eval judging',
  shadow_eval: 'Shadow eval',
  eval_bench: 'Benchmarking',
}
const surfaceLabel = (surface: string) => SURFACE_LABEL[surface] ?? surface

export function UserUsageDrilldown({ userId, days }: { userId: string; days: number }) {
  const [report, setReport] = useState<UsageReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    setReport(null)
    setLoading(true)
    setError(false)
    fetch(`/api/admin/users/${userId}/usage?days=${days}`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body) => { if (alive) setReport(body) })
      .catch(() => { if (alive) setError(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [userId, days])

  if (loading) return <p className="text-xs text-muted-foreground">Loading usage…</p>
  if (error || !report) return <p className="text-xs text-muted-foreground">Could not load model usage for this account.</p>

  if (report.totals.calls === 0) {
    return <p className="text-xs text-muted-foreground">No model calls attributed to this account in the last {report.days} days.</p>
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-4">
        <MiniStat label="Calls" value={report.totals.calls.toLocaleString()} />
        <MiniStat
          label="Tokens"
          value={tokens(report.totals.inputTokens + report.totals.cacheReadTokens + report.totals.cacheWriteTokens + report.totals.outputTokens)}
        />
        <MiniStat
          label="Cache reads"
          value={`${tokens(report.totals.cacheReadTokens)} · ${tokens(report.totals.cacheWriteTokens)} written`}
        />
        <MiniStat label="Estimated cost" value={usd(report.totals.costUsd)} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By model</h3>
          <ul className="space-y-1 text-sm">
            {report.byModel.map((row) => (
              <li key={`${row.provider}:${row.model}`} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                <span className="truncate">{row.model}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {row.calls} calls · {usd(row.costUsd)}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By surface</h3>
          <ul className="space-y-1 text-sm">
            {report.bySurface.map((row) => (
              <li key={row.surface} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                <span className="truncate">{surfaceLabel(row.surface)}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {row.calls} calls · {usd(row.costUsd)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        {report.dataSince
          ? `Data since ${new Date(report.dataSince).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}, unbounded within the ${report.days}-day window.`
          : `No model calls recorded for this account in the ${report.days}-day window.`}
        {' '}Cost figures are estimated, not invoice-reconciled.
        {report.hasUnattributedOrgUsage
          ? ' Some of this workspace’s usage predates per-person tracking and is not attributed to any account, so these figures may under-report.'
          : ''}
      </p>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  )
}
