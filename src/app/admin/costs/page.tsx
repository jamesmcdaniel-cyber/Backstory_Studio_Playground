'use client'

import { useEffect, useState } from 'react'

type Report = {
  days: number
  total: { costUsd: number; inputTokens: number; cacheReadTokens: number; outputTokens: number; calls: number }
  dataSince: string | null
  byOrg: {
    organizationId: string
    name: string
    costUsd: number
    inputTokens: number
    cacheReadTokens: number
    outputTokens: number
  }[]
  bySurface: { surface: string; costUsd: number; calls: number }[]
  byModel: { provider: string; model: string; priceVersion: string; costUsd: number; calls: number }[]
}

const usd = (value: number) => `$${value.toFixed(2)}`

export default function CostsPage() {
  const [report, setReport] = useState<Report | null>(null)
  const [days, setDays] = useState(30)

  useEffect(() => {
    void (async () => {
      const response = await fetch(`/api/admin/costs?days=${days}`, { cache: 'no-store' })
      if (response.ok) setReport(await response.json())
    })()
  }, [days])

  const unknownPricing = report?.byModel.filter((row) => row.priceVersion === 'unknown') ?? []
  const total = report?.total.costUsd ?? 0

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Model spend</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Internal estimate from the price table — not reconciled against provider invoices. Per-call detail is
            kept for 90 days; run totals survive longer.
          </p>
        </div>
        <select
          value={days}
          onChange={(event) => setDays(Number(event.target.value))}
          className="rounded-md border px-3 py-2 text-sm"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </header>

      {report && (
        <div>
          <p className="text-3xl font-semibold tabular-nums">
            {usd(total)}
            <span className="ml-2 text-sm font-normal text-muted-foreground">across all workspaces</span>
          </p>
          {report.dataSince && (
            <p className="mt-1 text-xs text-muted-foreground">
              Data since {new Date(report.dataSince).toLocaleDateString()}
              {/* The 90-day retention prune can make the true floor of the table
                  newer than the requested window — this is that floor, not a
                  restatement of the days picker above. */}
              {' '}— the oldest call still on record, which may be more recent than the {days}-day window if older
              rows have already been pruned.
            </p>
          )}
        </div>
      )}

      {unknownPricing.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium">Some calls have no price.</p>
          <p className="mt-1 text-muted-foreground">
            {unknownPricing.map((row) => `${row.provider}:${row.model}`).join(', ')} — add rates to
            src/lib/usage/pricing.ts. Their cost currently counts as zero, so the totals above are understated.
          </p>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-medium">By workspace — top 50 by spend</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2">Workspace</th>
                <th>Cost</th>
                <th>Input</th>
                <th>Cache reads</th>
                <th>Output</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {report?.byOrg.map((row) => (
                <tr key={row.organizationId}>
                  <td className="py-2">{row.name}</td>
                  <td className="tabular-nums">{usd(row.costUsd)}</td>
                  <td className="tabular-nums">{row.inputTokens.toLocaleString()}</td>
                  <td className="tabular-nums">{row.cacheReadTokens.toLocaleString()}</td>
                  <td className="tabular-nums">{row.outputTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report?.byOrg.length === 0 && <p className="text-sm text-muted-foreground">No spend recorded yet.</p>}
      </section>

      <section className="grid gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-sm font-medium">By surface</h2>
          <ul className="divide-y rounded-lg border text-sm">
            {report?.bySurface.map((row) => (
              <li key={row.surface} className="flex justify-between px-4 py-2">
                <span>{row.surface.replace(/_/g, ' ')}</span>
                <span className="tabular-nums text-muted-foreground">
                  {usd(row.costUsd)} · {row.calls.toLocaleString()} calls
                </span>
              </li>
            ))}
          </ul>
        </div>
        {/* Deliberately a link, not a second table. Per-model spend belongs
            beside per-model latency — the two are only useful read together,
            and a copy here would be the one that drifts out of the same window. */}
        <div className="space-y-2">
          <h2 className="text-sm font-medium">By model — top 50 by spend</h2>
          <div className="rounded-lg border px-4 py-3 text-sm">
            <p className="text-muted-foreground">
              {report?.byModel.length ?? 0} models (up to the top 50 by spend) served calls in this window.
            </p>
            <a href="/admin/users" className="mt-1 inline-block font-medium underline underline-offset-4">
              Cost and performance per model →
            </a>
          </div>
        </div>
      </section>
    </div>
  )
}
