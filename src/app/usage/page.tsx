'use client'

/**
 * Usage — the signed-in member's OWN month-to-date model spend.
 *
 * The sidebar's credits bar has always shown "X% of credits" with no way to
 * see what made it up. This is that drill-down: reached from the credits bar
 * itself (see components/layout/sidebar.tsx), scoped through
 * GET /api/usage/me — org-scoped and further filtered to the caller's own
 * rows, so a member here can never see a colleague's spend, only the
 * workspace-level credits context they already saw in the sidebar.
 *
 * Same honesty conventions as the admin console: costs are estimates, the
 * window is month-to-date (never implying older history), and a footnote
 * discloses when the workspace has usage that predates per-person tracking
 * or is org-level (bench/eval spend) rather than any one person's.
 */

import { useEffect, useState } from 'react'
import { Section } from '@/components/settings/section'
import { creditUsagePct } from '@/lib/usage/credit-pct'

type Rollup = {
  calls: number
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  costUsd: number
}
type ModelRow = Rollup & { provider: string; model: string }
type SurfaceRow = Rollup & { bucket: 'agent' | 'flow' | 'chat' | 'other' }
type Report = {
  since: string
  totals: Rollup
  byModel: ModelRow[]
  bySurface: SurfaceRow[]
  hasUnattributedOrgUsage: boolean
  credits: { usedTokens: number; budgetTokens: number; exempt: boolean }
}

const usd = (value: number) => (value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : '<$0.01')

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

const BUCKET_LABEL: Record<SurfaceRow['bucket'], string> = {
  agent: 'Agent runs',
  flow: 'Flow AI steps',
  chat: 'Chat',
  other: 'Other',
}

export default function UsagePage() {
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/usage/me', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body) => { if (alive) setReport(body) })
      .catch(() => { if (alive) setError(true) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [])

  const monthLabel = report
    ? new Date(report.since).toLocaleDateString(undefined, { year: 'numeric', month: 'long' })
    : null

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">Usage</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Your own model usage this month.</p>
      </div>

      <Section
        title="Credits"
        description={monthLabel ? `Workspace budget for ${monthLabel}.` : 'Workspace credit budget.'}
      >
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!loading && error && <p className="text-sm text-muted-foreground">Could not load your usage.</p>}
        {!loading && !error && report && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>Workspace usage this month</span>
              <span>{report.credits.exempt ? 'Unlimited' : `${creditUsagePct(report.credits.usedTokens, report.credits.budgetTokens)}% of credits`}</span>
            </div>
            {!report.credits.exempt && (
              <div className="h-1.5 overflow-hidden rounded-full bg-graphite-200">
                <div
                  className="h-full rounded-full bg-horizon-500"
                  style={{ width: `${creditUsagePct(report.credits.usedTokens, report.credits.budgetTokens)}%` }}
                />
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              This is the whole workspace&apos;s credit budget, shared with your teammates — the breakdown below is yours alone.
            </p>
          </div>
        )}
      </Section>

      {!loading && !error && report && (
        <Section title="Your usage" description="Model calls attributed to your account, month to date.">
          {report.totals.calls === 0 ? (
            <p className="text-sm text-muted-foreground">No model calls attributed to your account yet this month.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Calls" value={report.totals.calls.toLocaleString()} />
                <Stat
                  label="Tokens"
                  value={tokens(report.totals.inputTokens + report.totals.cacheReadTokens + report.totals.cacheWriteTokens + report.totals.outputTokens)}
                />
                <Stat label="Cache reads" value={tokens(report.totals.cacheReadTokens)} />
                <Stat label="Estimated cost" value={usd(report.totals.costUsd)} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By type</h3>
                  <ul className="space-y-1 text-sm">
                    {report.bySurface.map((row) => (
                      <li key={row.bucket} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                        <span>{BUCKET_LABEL[row.bucket]}</span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{row.calls} calls · {usd(row.costUsd)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By model</h3>
                  <ul className="space-y-1 text-sm">
                    {report.byModel.map((row) => (
                      <li key={`${row.provider}:${row.model}`} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                        <span className="truncate">{row.model}</span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{row.calls} calls · {usd(row.costUsd)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </>
          )}

          <p className="text-xs text-muted-foreground">
            Month to date{monthLabel ? ` (${monthLabel})` : ''}. Cost figures are estimated, not invoice-reconciled.
            {report.hasUnattributedOrgUsage
              ? ' Your workspace also has usage this month that isn’t attributed to any one person (older history, or shared benchmarking runs) — it isn’t counted above and isn’t billed to you.'
              : ''}
          </p>
        </Section>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  )
}
