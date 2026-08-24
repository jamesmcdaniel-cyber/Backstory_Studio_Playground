'use client'

import { useEffect, useState } from 'react'
import { RateLine, type RatePoint } from './rate-line'

type Week = {
  weekStart: string
  agentsCreated: number
  agentsDeleted: number
  execTotal: number
  execManual: number
  execByTrigger: Record<string, number>
  engagedUsers: number
  approvalsApproved: number
  approvalsRejected: number
  approvalsOther: number
  automationRatio: number | null
  acceptanceRate: number | null
}

type SurvivalRow = {
  cohortWeek: string
  size: number
  cells: { offset: number; active: number; rate: number }[]
}

type Report = {
  latestWeek: string | null
  weeks: Week[]
  survival: SurvivalRow[]
  depthDistribution: { bucket: string; organizations: number }[]
  byOrg: {
    organizationId: string
    name: string
    execTotal: number
    automationRatio: number | null
    acceptanceRate: number | null
    engagedUsers: number
    depthBucket: string
  }[]
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** null renders as an em dash, never as 0% — they mean opposite things. */
const pct = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`)

/**
 * Has the week at `offset` after this cohort actually happened yet?
 *
 * A cohort created three weeks ago has no week-12 cell. Rendering that as 0%
 * would report total abandonment for an agent population that simply has not
 * had twelve weeks to live yet — the most misreadable cell on the page.
 */
function hasElapsed(cohortWeek: string, offset: number, latestWeek: string | null): boolean {
  if (!latestWeek) return false
  const cell = new Date(Date.parse(`${cohortWeek}T00:00:00Z`) + offset * WEEK_MS)
  return cell.toISOString().slice(0, 10) <= latestWeek
}

/**
 * Sequential ramp, one hue, light→dark by magnitude — validated monotonic, with
 * the text colour on each step chosen so every cell clears 4.5:1 in BOTH modes
 * (graphite-900 on the light steps, white on the dark ones; dark mode gets its
 * own selected steps ascending from the dark surface, not an automatic flip).
 *
 * Zero is a NEUTRAL, not the faintest hue: absence of survival is a different
 * kind of fact from a little bit of it, and horizon-900 sits at 1.05:1 against
 * the dark surface anyway — invisible as a mark.
 */
function cellClass(rate: number): string {
  if (rate <= 0) return 'bg-graphite-100 text-muted-foreground dark:bg-graphite-800'
  if (rate <= 0.25) return 'bg-horizon-100 text-graphite-900 dark:bg-horizon-700 dark:text-white'
  if (rate <= 0.5) return 'bg-horizon-200 text-graphite-900 dark:bg-horizon-500 dark:text-white'
  if (rate <= 0.75) return 'bg-horizon-400 text-graphite-900 dark:bg-horizon-300 dark:text-graphite-900'
  return 'bg-horizon-600 text-white dark:bg-horizon-100 dark:text-graphite-900'
}

const MAX_OFFSET = 12

export default function AdoptionPage() {
  const [report, setReport] = useState<Report | null>(null)
  const [weeks, setWeeks] = useState(26)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch(`/api/admin/adoption?weeks=${weeks}`, { cache: 'no-store' })
        if (cancelled) return
        if (response.ok) {
          setReport(await response.json())
          setFailed(false)
        } else {
          setFailed(true)
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [weeks])

  const latest = report?.weeks[report.weeks.length - 1]
  const automationPoints: RatePoint[] =
    report?.weeks.map((week) => ({ label: week.weekStart, value: week.automationRatio })) ?? []
  const acceptancePoints: RatePoint[] =
    report?.weeks.map((week) => ({ label: week.weekStart, value: week.acceptanceRate })) ?? []
  const maxDepth = Math.max(1, ...(report?.depthDistribution.map((d) => d.organizations) ?? [1]))

  return (
    <div className="space-y-10">
      <header className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Adoption</h1>
          {/* A stalled rollup job has to be visible here rather than silently
              serving last month's numbers as though they were current. */}
          <p className="mt-1 text-sm text-muted-foreground">
            {report?.latestWeek
              ? `Complete weeks through ${report.latestWeek}. The in-progress week is excluded — a partial week always reads as a dip.`
              : 'No rollups yet. Run /api/cron/adoption-rollup to populate this page.'}
          </p>
        </div>
        <label className="text-sm">
          <span className="sr-only">Window</span>
          <select
            value={weeks}
            onChange={(event) => setWeeks(Number(event.target.value))}
            className="rounded-md border px-3 py-2 text-sm"
          >
            <option value={13}>Last 13 weeks</option>
            <option value={26}>Last 26 weeks</option>
            <option value={52}>Last 52 weeks</option>
          </select>
        </label>
      </header>

      {failed && (
        <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
          Could not load the report.
        </p>
      )}

      {latest && (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Automation ratio', value: pct(latest.automationRatio) },
            { label: 'Acceptance rate', value: pct(latest.acceptanceRate) },
            { label: 'Agents created', value: String(latest.agentsCreated) },
            { label: 'Engaged seats', value: String(latest.engagedUsers) },
          ].map((tile) => (
            <div key={tile.label} className="rounded-lg border p-4">
              <p className="text-sm text-muted-foreground">{tile.label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{tile.value}</p>
            </div>
          ))}
        </section>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Agent survival by cohort</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Share of agents created in a week that were still running N weeks later. Agents created
            and never run stay in the denominator — that is the case this table exists to catch. A
            cohort is only shown for weeks that have actually elapsed.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm tabular-nums">
            <caption className="sr-only">
              Agent survival by creation cohort, percentage still active by week offset
            </caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="px-2 py-1 text-left font-medium">Cohort</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Agents</th>
                {Array.from({ length: MAX_OFFSET + 1 }, (_, offset) => (
                  <th key={offset} scope="col" className="px-2 py-1 text-right font-medium">
                    W+{offset}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(report?.survival ?? []).map((row) => (
                <tr key={row.cohortWeek}>
                  <th scope="row" className="whitespace-nowrap px-2 py-1 text-left font-normal">
                    {row.cohortWeek}
                  </th>
                  <td className="px-2 py-1 text-right text-muted-foreground">{row.size}</td>
                  {row.cells.map((cell) => {
                    const elapsed = hasElapsed(row.cohortWeek, cell.offset, report?.latestWeek ?? null)
                    return (
                      <td key={cell.offset} className="p-px">
                        {/* p-px on the cell is the 2px surface gap between
                            adjacent fills, so neighbouring shades stay distinct. */}
                        <div
                          className={`rounded px-2 py-1 text-right ${
                            elapsed ? cellClass(row.size > 0 ? cell.rate : 0) : 'text-muted-foreground'
                          }`}
                          title={
                            elapsed
                              ? `${row.cohortWeek} + ${cell.offset}w: ${cell.active} of ${row.size} active`
                              : `${row.cohortWeek} + ${cell.offset}w has not elapsed yet`
                          }
                        >
                          {elapsed ? pct(row.size > 0 ? cell.rate : null) : '—'}
                        </div>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {(report?.survival.length ?? 0) === 0 && (
            <p className="text-sm text-muted-foreground">No cohorts in this window.</p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Automation ratio</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Share of runs that were not started by hand. An agent that only ever runs when a human
            pokes it is a chat window with an avatar, not a teammate. Weeks with no runs at all are
            a gap in the line, not a zero.
          </p>
        </div>
        <RateLine points={automationPoints} ariaLabel="Automation ratio by week" />
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Engaged-user depth</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Workspaces by how many distinct people ran an agent or wrote to one, in{' '}
            {report?.latestWeek ?? 'the latest complete week'}. One person doing everything is a
            pilot, not an adoption.
          </p>
        </div>
        <ul className="space-y-2">
          {(report?.depthDistribution ?? []).map((row) => (
            <li key={row.bucket} className="flex items-center gap-3 text-sm">
              <span className="w-16 shrink-0 text-muted-foreground">
                {row.bucket === '0' ? 'none' : `${row.bucket} ${row.bucket === '1' ? 'person' : 'people'}`}
              </span>
              <span className="flex h-4 flex-1 items-center">
                <span
                  className="h-4 rounded-sm bg-horizon-500 dark:bg-horizon-300"
                  style={{ width: `${(row.organizations / maxDepth) * 100}%` }}
                  title={`${row.organizations} workspaces`}
                />
              </span>
              <span className="w-10 shrink-0 text-right tabular-nums">{row.organizations}</span>
            </li>
          ))}
        </ul>
        {/* Spec requirement, not decoration: without this the two healthiest
            signals in the product get read as the two worst. */}
        <p className="text-sm text-muted-foreground">
          Low engaged-user depth alongside a high automation ratio is the target state, not decay:
          it means the work runs without anyone having to ask. Read the two together — depth falling
          while automation rises is success.
        </p>
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-medium">Acceptance rate</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Approvals granted as a share of those decided. High run volume with high rejection means
            agents are doing work nobody wants — dust with good uptime.
          </p>
        </div>
        <RateLine points={acceptancePoints} ariaLabel="Approval acceptance rate by week" />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">
          By workspace — {report?.latestWeek ?? 'latest complete week'}
        </h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">
              Per-workspace adoption for the latest complete week, top 50 by run count
            </caption>
            <thead>
              <tr className="text-muted-foreground">
                <th scope="col" className="px-2 py-1 text-left font-medium">Workspace</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Runs</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Automated</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">Accepted</th>
                <th scope="col" className="px-2 py-1 text-right font-medium">People</th>
              </tr>
            </thead>
            <tbody>
              {(report?.byOrg ?? []).map((row) => (
                <tr key={row.organizationId} className="border-t">
                  <th scope="row" className="px-2 py-1 text-left font-normal">{row.name}</th>
                  <td className="px-2 py-1 text-right tabular-nums">{row.execTotal}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{pct(row.automationRatio)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{pct(row.acceptanceRate)}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{row.engagedUsers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          Up to the top 50 workspaces by run count — not the complete list. Demo workspaces are
          excluded everywhere on this page: their history is canned data a clone wrote for itself.
        </p>
      </section>
    </div>
  )
}
