'use client'

/**
 * Per-model cost AND performance, in one table.
 *
 * The two live together on purpose. "Opus costs six times Sonnet" argues for
 * nothing by itself; "Opus costs six times Sonnet and answers no faster on this
 * workload" is a decision an operator can act on. Separating them across two
 * screens is how they end up measured over different windows and stop being
 * comparable at all.
 *
 * Sorted by spend, because the question this tab exists to answer is "where is
 * the money going", and the performance columns are what tell you whether that
 * spend is buying anything.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Play, Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { modelTier } from '@/lib/usage/model-tiers'
import { modelProviderBrand } from '@/lib/llm/provider-brand'

type Outcome = {
  runs: number
  succeeded: number
  failed: number
  successRate: number | null
  avgTurns: number | null
  mixedProviderRuns: number
  guardrailRefusals: number
}

type ModelRow = {
  provider: string
  model: string
  calls: number
  runs: number
  costUsd: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  timedCalls: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  outputTokensPerSecond: number | null
  unpriced: boolean
  outcomes: Outcome | null
}

type BenchRow = {
  provider: string
  model: string
  judgeModel: string | null
  avgScore: number | null
  samples: number
  /** Fixture attempts that errored (endpoint down, judge failure) — no score. */
  errors: number
  lastRunAt: string | null
}

/** One fixture-level result, judge reasoning included — the drill-down rows. */
type BenchDetailRow = {
  model: string
  subject: string
  score: number | null
  pass: boolean | null
  reasoning: string | null
  judgeModel: string | null
  latencyMs: number | null
  outputTokens: number
  createdAt: string
  /** Scored under an older harness than CURRENT_HARNESS_VERSION — excluded from the aggregate above, shown here badged. */
  stale: boolean
  /** The judge's per-sample {score, reasoning} verdicts backing the mean in `score`. */
  samples: { score: number; reasoning: string }[] | null
}

type ShadowMatchup = {
  championModel: string
  challengerModel: string
  samples: number
  challengerWins: number
  ties: number
  avgChampionScore: number
  avgChallengerScore: number
  challengerCostUsd: number
}

type Report = {
  days: number
  /** True totals for the window, from an unbounded aggregate — never the sum of `models`, which is capped at the top 50 by spend. */
  total: { costUsd: number; calls: number }
  /** Earliest call actually in the window; may be newer than the requested window if the 90-day retention prune has already removed older rows. */
  dataSince: string | null
  models: ModelRow[]
  bench: BenchRow[]
  benchDetail: BenchDetailRow[]
  shadow: ShadowMatchup[]
  /** null = could not check (inline mode / Redis unreachable). */
  benchRunning: boolean | null
  /** Models the candidate picker may offer (endpoint configured). */
  benchable: string[]
  /** Deployment's shadow-sampling state; null = off. */
  shadowSampling: { model: string; rate: number } | null
  limits: { frontierClaudeRunsPerDay: number; claudeRunsPerDay: number }
}

const usd = (value: number) => (value >= 0.01 || value === 0 ? `$${value.toFixed(2)}` : '<$0.01')

/** Seconds once a call is past a second — an operator reads "4.2s", not "4213ms". */
function duration(ms: number | null): string {
  if (ms == null) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

const percent = (value: number | null) => (value == null ? '—' : `${Math.round(value * 100)}%`)

function tokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(Math.round(value))
}

export function ModelsPanel({ days }: { days: number }) {
  const [report, setReport] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [benchBusy, setBenchBusy] = useState(false)
  /** Chip selection; null until the roster arrives, then defaults to all. */
  const [candidates, setCandidates] = useState<string[] | null>(null)
  /** Which bench model rows are expanded to their per-fixture detail. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const alive = useRef(true)

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const response = await fetch(`/api/admin/models?days=${days}`, { cache: 'no-store' })
      if (alive.current && response.ok) {
        const body: Report = await response.json()
        setReport(body)
        // First load only: default to benching everything configured. A
        // selection the operator already made is never overwritten by a poll.
        setCandidates((current) => current ?? body.benchable)
      }
    } finally {
      if (alive.current && !silent) setLoading(false)
    }
  }, [days])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  // While a bench is queued or running, refresh quietly so its rows appear
  // without the operator hammering reload. Stops the moment it is not.
  // null ("could not check" — inline mode or an unreachable queue) keeps
  // polling too: silently treating "unknown" as "idle" is how a second bench
  // gets started on top of one that is actually still running.
  const benchInFlight = benchBusy || report?.benchRunning === true || report?.benchRunning === null
  useEffect(() => {
    if (!benchInFlight) return
    const timer = setInterval(() => void load(true), 15_000)
    return () => clearInterval(timer)
  }, [benchInFlight, load])

  const toggleCandidate = (model: string) => {
    setCandidates((current) => {
      const list = current ?? report?.benchable ?? []
      return list.includes(model) ? list.filter((entry) => entry !== model) : [...list, model]
    })
  }

  const startBench = async () => {
    setBenchBusy(true)
    try {
      const response = await fetch('/api/admin/models/bench', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: candidates ?? [] }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        toast.error(body?.error ?? 'Could not start the bench.')
        setBenchBusy(false)
        return
      }
      toast.success(
        body?.alreadyRunning
          ? 'A bench is already running — results will appear here when it finishes.'
          : 'Bench started. Every candidate model runs the same fixtures; results land below as they finish.',
      )
      void load(true)
    } catch {
      toast.error('Could not start the bench.')
      setBenchBusy(false)
    }
  }

  const models = report?.models ?? []
  const unpriced = models.filter((row) => row.unpriced)
  // Coverage of the visible (top-50) rows only — how much of what is on
  // screen has a latency measurement. Never presented as a window-wide total.
  const shownTimedCalls = models.reduce((sum, row) => sum + row.timedCalls, 0)
  const shownCalls = models.reduce((sum, row) => sum + row.calls, 0)

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Spend" value={usd(report?.total.costUsd ?? 0)} />
        <Stat label="Calls" value={(report?.total.calls ?? 0).toLocaleString()} />
        <Stat label="Models in use (top 50 by spend)" value={String(models.length)} />
        <Stat
          label="Endpoints (top 50 by spend)"
          value={String(new Set(models.map((row) => row.provider)).size)}
        />
      </div>

      {report?.dataSince && (
        <p className="text-xs text-muted-foreground">
          Data since {new Date(report.dataSince).toLocaleDateString()} — the oldest call still on record, which may
          be more recent than the {days}-day window if older rows have already been pruned.
        </p>
      )}

      {unpriced.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium">Some calls have no price, so the spend above is understated.</p>
          <p className="mt-1 text-muted-foreground">
            {unpriced.map((row) => `${row.provider}:${row.model}`).join(', ')} — Claude rates live in
            src/lib/usage/pricing.ts. Qwen has no list price to hardcode (it is whatever endpoint QWEN_BASE_URL
            points at, on your own contract), so set QWEN_PRICE_INPUT_PER_MTOK and QWEN_PRICE_OUTPUT_PER_MTOK to
            price it.
          </p>
        </div>
      )}

      <p className="text-xs text-muted-foreground">Table below: top 50 models by spend in this window.</p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[64rem] text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2 font-medium">Model</th>
              <th className="px-4 py-2 font-medium">Runs touched</th>
              <th className="px-4 py-2 font-medium">Calls</th>
              <th className="px-4 py-2 font-medium">Cost</th>
              <th className="px-4 py-2 font-medium">Per run</th>
              <th className="px-4 py-2 font-medium">Success</th>
              <th className="px-4 py-2 font-medium">Turns</th>
              <th className="px-4 py-2 font-medium">Avg</th>
              <th className="px-4 py-2 font-medium">p95</th>
              <th className="px-4 py-2 font-medium">Output</th>
              <th className="px-4 py-2 font-medium">Tok/s</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {models.map((row) => {
              const tier = modelTier(row.model)
              return (
                <tr key={`${row.provider}:${row.model}`}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.model}</span>
                      {tier === 'frontier' && <Badge variant="warn">Frontier</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">{modelProviderBrand(row.model)?.name ?? row.provider}</div>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{row.runs.toLocaleString()}</td>
                  <td className="px-4 py-2.5 tabular-nums">{row.calls.toLocaleString()}</td>
                  <td className="px-4 py-2.5 tabular-nums">{row.unpriced ? '—' : usd(row.costUsd)}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {row.unpriced || row.runs === 0 ? '—' : usd(row.costUsd / row.runs)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="tabular-nums">{percent(row.outcomes?.successRate ?? null)}</span>
                    {/* Facts that change how the success number reads: runs a
                        mid-run fallback handed to another endpoint, and runs
                        that ended in an audited guardrail refusal. */}
                    {row.outcomes && (row.outcomes.mixedProviderRuns > 0 || row.outcomes.guardrailRefusals > 0) && (
                      <div className="text-xs text-muted-foreground">
                        {[
                          row.outcomes.mixedProviderRuns > 0 ? `${row.outcomes.mixedProviderRuns} mixed` : null,
                          row.outcomes.guardrailRefusals > 0 ? `${row.outcomes.guardrailRefusals} refusals` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {row.outcomes?.avgTurns == null ? '—' : row.outcomes.avgTurns.toFixed(1)}
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{duration(row.avgLatencyMs)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{duration(row.p95LatencyMs)}</td>
                  <td className="px-4 py-2.5 tabular-nums">{tokens(row.outputTokens)}</td>
                  <td className="px-4 py-2.5 tabular-nums">
                    {row.outputTokensPerSecond == null ? '—' : Math.round(row.outputTokensPerSecond)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {!loading && models.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">No model calls in this window.</p>
        )}
        {loading && <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>}
      </div>

      {/* ── Quality ─────────────────────────────────────────────────────────
          Cost and latency say a model is cheaper; only these say whether it
          did the job. Both sections generalize to any model that gets added —
          rows appear per provider:model straight from the eval table. */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">Quality — bench</h2>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void startBench()}
            disabled={benchInFlight || (candidates !== null && candidates.length === 0)}
          >
            {benchBusy || report?.benchRunning === true ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Bench running…
              </>
            ) : report?.benchRunning === null ? (
              <>
                <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                Status unknown…
              </>
            ) : (
              <>
                <Play className="mr-2 h-3.5 w-3.5" />
                Run bench
              </>
            )}
          </Button>
        </div>
        {report?.benchRunning === null && !benchBusy && (
          <p className="text-xs text-muted-foreground">
            Could not confirm whether a bench is already running, so the button stays disabled until the next check.
          </p>
        )}
        {/* Which models the next Run bench covers. Only endpoints this
            deployment holds keys for appear; the selection is honored by the
            worker after re-validation, so a chip is a promise, not a hint. */}
        {(report?.benchable.length ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Candidates:</span>
            {report?.benchable.map((model) => {
              const selected = (candidates ?? report.benchable).includes(model)
              return (
                <button
                  key={model}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggleCandidate(model)}
                  disabled={benchInFlight}
                  className={cn(
                    'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                    selected
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-input text-muted-foreground hover:bg-accent/50',
                    benchInFlight && 'opacity-60',
                  )}
                >
                  {model}
                </button>
              )
            })}
            {candidates !== null && candidates.length === 0 && (
              <span className="text-xs text-muted-foreground">Pick at least one model to run.</span>
            )}
          </div>
        )}
        {(report?.bench.length ?? 0) > 0 ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Model</th>
                  <th className="px-4 py-2 font-medium">Avg score</th>
                  <th className="px-4 py-2 font-medium">Samples</th>
                  <th className="px-4 py-2 font-medium">Errors</th>
                  <th className="px-4 py-2 font-medium">Judge</th>
                  <th className="px-4 py-2 font-medium">Last run</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report?.bench.map((row) => {
                  const key = `${row.provider}:${row.model}:${row.judgeModel}`
                  const detail = report.benchDetail.filter(
                    (entry) => entry.model === row.model && entry.judgeModel === row.judgeModel,
                  )
                  const open = Boolean(expanded[key])
                  return (
                    <Fragment key={key}>
                      {/* The average is a claim; the detail rows are the
                          evidence. Expanding shows every fixture with the
                          judge's own reasoning — the first bench's inverted
                          scores were diagnosed by exactly this read. */}
                      <tr
                        className="cursor-pointer transition-colors hover:bg-accent/40"
                        onClick={() => setExpanded((current) => ({ ...current, [key]: !open }))}
                      >
                        <td className="px-4 py-2.5 font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            {row.model}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 tabular-nums">{row.avgScore == null ? '—' : row.avgScore.toFixed(3)}</td>
                        <td className="px-4 py-2.5 tabular-nums">{row.samples}</td>
                        <td className={cn('px-4 py-2.5 tabular-nums', row.errors > 0 && 'text-destructive')}>
                          {row.errors || '—'}
                        </td>
                        <td className="px-4 py-2.5 text-muted-foreground">{row.judgeModel ?? '—'}</td>
                        <td className="px-4 py-2.5 text-muted-foreground">
                          {row.lastRunAt ? new Date(row.lastRunAt).toLocaleDateString() : '—'}
                        </td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={6} className="bg-muted/20 px-4 py-3">
                            <ul className="space-y-3">
                              {detail.map((entry, index) => (
                                <li key={`${entry.subject}:${entry.createdAt}:${index}`} className="text-sm">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium">{entry.subject}</span>
                                    {entry.score == null ? (
                                      <Badge variant="risk">error</Badge>
                                    ) : (
                                      <span className="tabular-nums">{entry.score.toFixed(3)}</span>
                                    )}
                                    {entry.pass === false && entry.score != null && (
                                      <Badge variant="warn">structural fail</Badge>
                                    )}
                                    {entry.stale && (
                                      <Badge variant="warn" title="Scored under an older harness version — not in the average above.">
                                        stale harness
                                      </Badge>
                                    )}
                                    <span className="text-xs text-muted-foreground">
                                      {new Date(entry.createdAt).toLocaleString()}
                                      {entry.latencyMs != null && ` · ${duration(entry.latencyMs)}`}
                                    </span>
                                  </div>
                                  {entry.reasoning && (
                                    <p className={cn('mt-1 text-xs', entry.score == null ? 'text-destructive' : 'text-muted-foreground')}>
                                      {entry.reasoning}
                                    </p>
                                  )}
                                  {/* The mean is a claim; each sample is the evidence — shown so the
                                      number and its backing reasoning are never a mismatched pair. */}
                                  {entry.samples && entry.samples.length > 0 && (
                                    <ul className="mt-1.5 space-y-1 border-l pl-2">
                                      {entry.samples.map((sample, sampleIndex) => (
                                        <li key={sampleIndex} className="text-xs text-muted-foreground">
                                          <span className="tabular-nums font-medium text-foreground">{sample.score.toFixed(3)}</span>
                                          {sample.reasoning && ` — ${sample.reasoning}`}
                                        </li>
                                      ))}
                                    </ul>
                                  )}
                                </li>
                              ))}
                              {detail.length === 0 && (
                                <li className="text-xs text-muted-foreground">No per-fixture rows in this window.</li>
                              )}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
            {benchInFlight
              ? 'Bench in progress — every configured model is running the same fixtures. Results appear here as they land.'
              : 'No bench results in this window yet. Run bench puts every configured model through the same task fixtures, graded blind by one pinned judge, and keeps the scores here.'}
          </p>
        )}
        {/* Scores from different judges are different rulers; say so whenever
            the table is actually mixing them. */}
        {new Set(report?.bench.map((row) => row.judgeModel)).size > 1 && (
          <p className="text-xs text-muted-foreground">
            Multiple judges appear above — compare scores only within rows graded by the same judge.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Quality — shadow (real production tasks)</h2>
        {(report?.shadow.length ?? 0) > 0 ? (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[44rem] text-sm">
              <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Matchup</th>
                  <th className="px-4 py-2 font-medium">Samples</th>
                  <th className="px-4 py-2 font-medium">Challenger wins</th>
                  <th className="px-4 py-2 font-medium">Champion avg</th>
                  <th className="px-4 py-2 font-medium">Challenger avg</th>
                  <th className="px-4 py-2 font-medium">Extra spend</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report?.shadow.map((row) => (
                  <tr key={`${row.championModel}:${row.challengerModel}`}>
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{row.challengerModel}</span>
                      <span className="text-muted-foreground"> vs {row.championModel}</span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{row.samples}</td>
                    <td className="px-4 py-2.5 tabular-nums">
                      {percent(row.samples ? (row.challengerWins + row.ties / 2) / row.samples : null)}
                      <span className="text-xs text-muted-foreground"> ({row.ties} ties)</span>
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{row.avgChampionScore.toFixed(3)}</td>
                    <td className="px-4 py-2.5 tabular-nums">{row.avgChallengerScore.toFixed(3)}</td>
                    <td className="px-4 py-2.5 tabular-nums">{usd(row.challengerCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">
            {report?.shadowSampling
              ? `Shadow sampling is on — ${Math.round(report.shadowSampling.rate * 100)}% of flow AI steps also run through ${report.shadowSampling.model} and the pairs are judged blind. No samples have landed in this window yet.`
              : 'Shadow sampling is off in this deployment. When enabled, a sampled fraction of real flow AI steps also runs through a challenger model and the two answers are judged blind — the strongest evidence for a model swap. Only side-effect-free steps are shadowed; scores are stored, never the text.'}
          </p>
        )}
      </section>

      <p className="text-sm text-muted-foreground">
        &quot;Runs touched&quot; counts a run once for every model that served part of it, so a run split across two
        models is counted under both — the column can add up to more than the number of distinct runs in the
        window. Per-run cost divides this model&apos;s cost by the runs it touched, not by all runs in the window.
        Success and turns attribute each run to the model that actually served most of its calls — a run that asked
        for one model and was served by another (fallback) counts under the model that did the work. Success rate
        only counts runs that finished (succeeded or failed); runs still in flight or cancelled are excluded from
        both, so succeeded plus failed can be less than runs touched.
        Latency columns cover only calls made since per-call timing was recorded — of the {shownCalls.toLocaleString()}{' '}
        calls in the table above, {shownTimedCalls.toLocaleString()} carry a latency measurement — so a window
        reaching further back than that shows fewer timed calls than total calls. Everyone outside the operator tier
        is held to {report?.limits.frontierClaudeRunsPerDay ?? '—'} frontier-Claude runs and{' '}
        {report?.limits.claudeRunsPerDay ?? '—'} Claude runs a day; past either ceiling their runs route to Qwen
        rather than failing.
      </p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}
