import { systemPrisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { MODEL_LIMITS } from '@/lib/usage/model-tiers'
import { shadowConfig } from '@/lib/eval/shadow'
import { createQueue, getRedisConnection, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'

/**
 * Whether a bench is queued or running right now, so the panel can render the
 * button as busy instead of letting a second click double-spend. Best-effort:
 * an unreachable Redis answers null ("could not check"), never false — the
 * POST route re-checks authoritatively before enqueueing anyway.
 */
async function benchRunning(): Promise<boolean | null> {
  if (inlineExecution || !workersEnabled) return null
  try {
    await getRedisConnection().connect().catch(() => undefined)
    const counts = await createQueue(QUEUE_NAMES.MODEL_BENCH).getJobCounts('waiting', 'active', 'delayed')
    return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) > 0
  } catch {
    return null
  }
}

/**
 * Per-model cost AND performance, for the Models tab of the operator console.
 *
 * Deliberately one query rather than a cost rollup plus a latency rollup: the
 * two numbers are only useful together. "Opus costs 6x Sonnet" is an argument
 * for nothing on its own — "Opus costs 6x Sonnet and answers in the same time"
 * is a decision. Splitting them across endpoints is how they drift out of the
 * same window and stop being comparable.
 *
 * Raw SQL because the interesting latency figure is the p95, and an average
 * hides exactly the tail an operator is looking for. Prisma's groupBy has no
 * percentile aggregate.
 *
 * systemPrisma: cross-org aggregate by design, same posture as /admin/costs.
 */

type Row = {
  provider: string
  model: string
  calls: number
  runs: number
  costUsd: number
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
  /** Calls that carry a latency measurement — rows predating the column do not. */
  timedCalls: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  /** Output tokens per second of model time, across the timed calls. */
  outputTokensPerSecond: number | null
  unpriced: boolean
  /** Production outcomes for runs this model SERVED (dominant attribution). */
  outcomes: Outcome | null
}

/**
 * What actually happened to the runs a model served. This is the half of the
 * "can a cheaper model do this job" question that cost and latency cannot
 * answer: a model that is 6x cheaper per token and fails twice as often, or
 * takes twice the turns to finish, is not 6x cheaper.
 */
type Outcome = {
  /** Runs attributed to this model (it served the most calls in the run). */
  runs: number
  succeeded: number
  failed: number
  /** succeeded / (succeeded + failed); waiting/cancelled runs excluded. */
  successRate: number | null
  /** Mean agent turns per agent run — the "does the cheap model flail" number. */
  avgTurns: number | null
  /** Runs where more than one endpoint served calls (mid-run fallback). */
  mixedProviderRuns: number
  /** Runs that ended in an audited guardrail refusal. */
  guardrailRefusals: number
}

export const GET = withAuthenticatedApi(async (request) => {
  const days = Math.min(90, Math.max(1, Number(request.nextUrl.searchParams.get('days')) || 30))
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

  // COALESCE over the two run columns: a call belongs to at most one of them,
  // and counting runs rather than calls is what makes the number comparable to
  // the daily ceilings in usage/model-allowance.ts.
  //
  // Every SUM is cast to float8: token totals overflow int4 on a busy window,
  // and Prisma hands back a BigInt for bigint columns, which JSON cannot
  // serialize. NULL latencies are skipped by AVG and PERCENTILE_CONT already —
  // the FILTER on the throughput sums keeps that numerator and denominator
  // over the same set of calls.
  const rows = await systemPrisma.$queryRaw<
    {
      provider: string
      model: string
      calls: number
      runs: number
      cost_usd: number
      input_tokens: number
      cache_read_tokens: number
      output_tokens: number
      timed_calls: number
      avg_latency_ms: number | null
      p95_latency_ms: number | null
      timed_output_tokens: number | null
      total_latency_ms: number | null
      unpriced: boolean
    }[]
  >`
    SELECT
      "provider",
      "model",
      COUNT(*)::int AS calls,
      COUNT(DISTINCT COALESCE("agentExecutionId", "flowRunId"))::int AS runs,
      COALESCE(SUM("costUsd"), 0)::float8 AS cost_usd,
      COALESCE(SUM("inputTokens"), 0)::float8 AS input_tokens,
      COALESCE(SUM("cacheReadTokens"), 0)::float8 AS cache_read_tokens,
      COALESCE(SUM("outputTokens"), 0)::float8 AS output_tokens,
      COUNT("latencyMs")::int AS timed_calls,
      AVG("latencyMs")::float8 AS avg_latency_ms,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "latencyMs")::float8 AS p95_latency_ms,
      SUM("outputTokens") FILTER (WHERE "latencyMs" IS NOT NULL)::float8 AS timed_output_tokens,
      SUM("latencyMs")::float8 AS total_latency_ms,
      BOOL_OR("priceVersion" = 'unknown') AS unpriced
    FROM "llm_calls"
    WHERE "createdAt" >= ${since}
    GROUP BY "provider", "model"
    ORDER BY COALESCE(SUM("costUsd"), 0) DESC, COUNT(*) DESC
    LIMIT 50
  `

  // ── Outcomes ─────────────────────────────────────────────────────────────
  //
  // Attribution is by which model SERVED the run — the model with the most
  // ledger calls in it — never by the model column on the run row, which
  // records what was REQUESTED. Cross-provider fallback makes the requested
  // model a lie for exactly the runs this view exists to compare: a run that
  // asked for Qwen and was served by Claude must count as Claude's outcome.
  //
  // COALESCE prefers agentExecutionId, so an agent step inside a flow is one
  // run (the execution), matching the runs count in the rollup above. Success
  // vocabulary differs by plane ('completed' for agents, 'succeeded' for
  // flows); waiting/running/cancelled runs sit outside the success denominator
  // because their outcome is not yet a fact.
  const outcomeRows = await systemPrisma.$queryRaw<
    {
      provider: string
      model: string
      runs: number
      succeeded: number
      failed: number
      avg_turns: number | null
      mixed_runs: number
      refusals: number
    }[]
  >`
    WITH per_run AS (
      SELECT
        COALESCE("agentExecutionId", "flowRunId") AS run_id,
        ("agentExecutionId" IS NOT NULL) AS is_agent,
        COUNT(*) FILTER (WHERE "surface" = 'agent_turn')::int AS turns,
        COUNT(DISTINCT "provider")::int AS providers
      FROM "llm_calls"
      WHERE "createdAt" >= ${since} AND COALESCE("agentExecutionId", "flowRunId") IS NOT NULL
      GROUP BY 1, 2
    ),
    dominant AS (
      SELECT DISTINCT ON (run_id) run_id, "provider", "model"
      FROM (
        SELECT COALESCE("agentExecutionId", "flowRunId") AS run_id, "provider", "model", COUNT(*) AS calls
        FROM "llm_calls"
        WHERE "createdAt" >= ${since} AND COALESCE("agentExecutionId", "flowRunId") IS NOT NULL
        GROUP BY 1, 2, 3
      ) grouped
      ORDER BY run_id, calls DESC
    ),
    refusals AS (
      SELECT DISTINCT "resourceId" AS run_id
      FROM "audit_events"
      WHERE "action" = 'guardrail.refusal' AND "createdAt" >= ${since}
    )
    SELECT
      d."provider",
      d."model",
      COUNT(*)::int AS runs,
      COUNT(*) FILTER (WHERE COALESCE(a."status", f."status") IN ('completed', 'succeeded'))::int AS succeeded,
      COUNT(*) FILTER (WHERE COALESCE(a."status", f."status") = 'failed')::int AS failed,
      AVG(p.turns) FILTER (WHERE p.is_agent AND p.turns > 0)::float8 AS avg_turns,
      COUNT(*) FILTER (WHERE p.providers > 1)::int AS mixed_runs,
      COUNT(*) FILTER (WHERE r.run_id IS NOT NULL)::int AS refusals
    FROM dominant d
    JOIN per_run p USING (run_id)
    LEFT JOIN "agent_executions" a ON p.is_agent AND a.id = d.run_id
    LEFT JOIN "flow_runs" f ON NOT p.is_agent AND f.id = d.run_id
    LEFT JOIN refusals r ON r.run_id = d.run_id
    GROUP BY 1, 2
  `
  const outcomeByModel = new Map(
    outcomeRows.map((row) => [
      `${row.provider}:${row.model}`,
      {
        runs: row.runs,
        succeeded: row.succeeded,
        failed: row.failed,
        successRate: row.succeeded + row.failed > 0 ? row.succeeded / (row.succeeded + row.failed) : null,
        avgTurns: row.avg_turns,
        mixedProviderRuns: row.mixed_runs,
        guardrailRefusals: row.refusals,
      } satisfies Outcome,
    ]),
  )

  const models: Row[] = rows.map((row) => ({
    provider: row.provider,
    model: row.model,
    calls: row.calls,
    runs: row.runs,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    cacheReadTokens: row.cache_read_tokens,
    outputTokens: row.output_tokens,
    timedCalls: row.timed_calls,
    avgLatencyMs: row.avg_latency_ms,
    p95LatencyMs: row.p95_latency_ms,
    outputTokensPerSecond:
      row.total_latency_ms && row.total_latency_ms > 0 && row.timed_output_tokens != null
        ? (row.timed_output_tokens / row.total_latency_ms) * 1000
        : null,
    unpriced: row.unpriced,
    outcomes: outcomeByModel.get(`${row.provider}:${row.model}`) ?? null,
  }))

  // ── Quality: bench scores and shadow comparisons over the window ─────────
  //
  // Same window as cost and outcomes, so all three read as one measurement.
  // Prisma groupBy (not raw SQL) — this table is platform-level, but staying on
  // the model API keeps the raw-SQL surface of this file to the one statement
  // the exemption list documents.
  const [benchGroups, shadowRows] = await Promise.all([
    systemPrisma.modelEvalResult.groupBy({
      by: ['provider', 'model', 'judgeModel'],
      where: { kind: 'bench', createdAt: { gte: since } },
      _avg: { score: true },
      _count: true,
      _max: { createdAt: true },
    }),
    systemPrisma.modelEvalResult.findMany({
      where: { kind: 'shadow', createdAt: { gte: since } },
      select: { pairId: true, provider: true, model: true, score: true, champion: true, costUsd: true },
      orderBy: { createdAt: 'desc' },
      // Bounded: pairs are aggregated in memory. 4000 rows = 2000 comparisons,
      // far past what a sampled shadow rate produces in 90 days.
      take: 4000,
    }),
  ])

  const bench = benchGroups
    .map((group) => ({
      provider: group.provider,
      model: group.model,
      judgeModel: group.judgeModel,
      avgScore: group._avg.score == null ? null : Number(group._avg.score),
      samples: group._count,
      lastRunAt: group._max.createdAt,
    }))
    .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))

  // Pair shadow rows and aggregate per champion-vs-challenger matchup. A pair
  // missing a side (a judge failure mid-write) is dropped rather than counted
  // as a win for whoever survived.
  const byPair = new Map<string, { champion?: (typeof shadowRows)[number]; challenger?: (typeof shadowRows)[number] }>()
  for (const row of shadowRows) {
    if (!row.pairId) continue
    const pair = byPair.get(row.pairId) ?? {}
    if (row.champion) pair.champion = row
    else pair.challenger = row
    byPair.set(row.pairId, pair)
  }
  type Matchup = {
    championModel: string
    challengerModel: string
    samples: number
    challengerWins: number
    ties: number
    avgChampionScore: number
    avgChallengerScore: number
    challengerCostUsd: number
  }
  const matchups = new Map<string, Matchup>()
  for (const { champion, challenger } of byPair.values()) {
    if (!champion || !challenger || champion.score == null || challenger.score == null) continue
    const key = `${champion.model} vs ${challenger.model}`
    const entry =
      matchups.get(key) ??
      ({
        championModel: champion.model,
        challengerModel: challenger.model,
        samples: 0,
        challengerWins: 0,
        ties: 0,
        avgChampionScore: 0,
        avgChallengerScore: 0,
        challengerCostUsd: 0,
      } satisfies Matchup)
    const championScore = Number(champion.score)
    const challengerScore = Number(challenger.score)
    entry.samples += 1
    if (challengerScore > championScore) entry.challengerWins += 1
    else if (challengerScore === championScore) entry.ties += 1
    // Running means, so the entry never holds a sum that needs a second pass.
    entry.avgChampionScore += (championScore - entry.avgChampionScore) / entry.samples
    entry.avgChallengerScore += (challengerScore - entry.avgChallengerScore) / entry.samples
    entry.challengerCostUsd += Number(challenger.costUsd)
    matchups.set(key, entry)
  }

  return {
    success: true,
    days,
    models,
    bench,
    shadow: [...matchups.values()].sort((a, b) => b.samples - a.samples),
    benchRunning: await benchRunning(),
    // Whether shadow sampling is switched on in this deployment, so the panel
    // reports config STATE ("off" / "on at 5% against qwen-3.7") instead of
    // printing env-var homework at the operator.
    shadowSampling: (() => {
      const config = shadowConfig({ rate: process.env.SHADOW_EVAL_RATE, model: process.env.SHADOW_EVAL_MODEL })
      return config ? { model: config.model, rate: config.rate } : null
    })(),
    // Shipped with the table so the tab can state the ceilings it is reporting
    // against, rather than the reader holding two numbers in their head.
    limits: MODEL_LIMITS,
  }
}, { permission: 'platform.administer', internalOnly: true })
