import { systemPrisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { MODEL_LIMITS } from '@/lib/usage/model-tiers'
import { shadowConfig } from '@/lib/eval/shadow'
import { benchableModels } from '@/lib/eval/bench'
import { CURRENT_HARNESS_VERSION } from '@/lib/eval/harness'
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

  // Demo orgs (kind === 'demo') are disposable anonymised clones of a real
  // workspace — see src/lib/demo/snapshot.ts. Their LlmCall rows are canned
  // history the clone wrote for itself, not real spend or real model
  // performance, so every cross-org query below (Prisma and raw SQL alike)
  // excludes organizations of that kind. LlmCall has no Prisma relation to
  // Organization (denormalized scalar FK only), so the Prisma aggregate below
  // filters by a precomputed id list, and the raw SQL joins "organizations"
  // directly on the same column.
  const demoOrgIds = (
    await systemPrisma.organization.findMany({ where: { kind: 'demo' }, select: { id: true } })
  ).map((org) => org.id)

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
      AND "organizationId" NOT IN (SELECT "id" FROM "organizations" WHERE "kind" = 'demo')
    GROUP BY "provider", "model"
    ORDER BY COALESCE(SUM("costUsd"), 0) DESC, COUNT(*) DESC
    LIMIT 50
  `

  // Unbounded — the raw-SQL rollup above is capped at the top 50 models by
  // spend for the table, but the Spend/Calls tiles must never be the sum of
  // that capped list. Same org scope as everything else on this route
  // (systemPrisma, no organizationId filter): cross-org by design, matching
  // the rollup above.
  const totalAgg = await systemPrisma.llmCall.aggregate({
    where: { createdAt: { gte: since }, organizationId: { notIn: demoOrgIds } },
    _sum: { costUsd: true },
    _count: { _all: true },
    _min: { createdAt: true },
  })

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
        -- Same headline exclusion as the dominant CTE: a haiku headline on a
        -- sonnet run is not a mid-run fallback.
        COUNT(DISTINCT "provider") FILTER (WHERE "surface" <> 'headline')::int AS providers
      FROM "llm_calls"
      WHERE "createdAt" >= ${since} AND COALESCE("agentExecutionId", "flowRunId") IS NOT NULL
        AND "organizationId" NOT IN (SELECT "id" FROM "organizations" WHERE "kind" = 'demo')
      GROUP BY 1, 2
    ),
    dominant AS (
      -- Which model DID the run's work. Headline rows are excluded: the
      -- one-line activity summary is bookkeeping that rides on every run, and
      -- counting it let a 1-turn run tie its own headline model and win the
      -- attribution on row order. The tiebreak is total, so attribution is
      -- deterministic run over run.
      SELECT DISTINCT ON (run_id) run_id, "provider", "model"
      FROM (
        SELECT COALESCE("agentExecutionId", "flowRunId") AS run_id, "provider", "model", COUNT(*) AS calls
        FROM "llm_calls"
        WHERE "createdAt" >= ${since}
          AND COALESCE("agentExecutionId", "flowRunId") IS NOT NULL
          AND "surface" <> 'headline'
          AND "organizationId" NOT IN (SELECT "id" FROM "organizations" WHERE "kind" = 'demo')
        GROUP BY 1, 2, 3
      ) grouped
      ORDER BY run_id, calls DESC, "provider", "model"
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
      // Legacy rows (harnessVersion default 'pre-2026-08-20', from before
      // fixture dispatch was fixed — see 4f48b3a9) must never blend into this
      // average: a run scored under different rules is not the same
      // measurement. They stay visible in benchDetail below (unfiltered),
      // badged stale, for anyone drilling in.
      where: { kind: 'bench', createdAt: { gte: since }, harnessVersion: CURRENT_HARNESS_VERSION },
      _avg: { score: true },
      // score counts only scored rows; _all includes error rows (score null),
      // so errors = _all - score and a candidate whose every fixture failed
      // still appears instead of vanishing from the table.
      _count: { _all: true, score: true },
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
      samples: group._count.score,
      errors: group._count._all - group._count.score,
      lastRunAt: group._max.createdAt,
    }))
    .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))

  // Per-fixture drill-down: the judge's reasoning is what turns a surprising
  // average into a diagnosis (the first bench's inversion was explained in one
  // read of these rows). Bench rows only — their inputs are checked-in
  // fixtures; shadow reasoning is never stored at all.
  const benchDetail = (
    await systemPrisma.modelEvalResult.findMany({
      // Unfiltered by harnessVersion on purpose: a legacy row is still real
      // evidence of what that fixture run produced, it is just not
      // comparable to current scores. The panel badges it stale instead of
      // hiding it.
      where: { kind: 'bench', createdAt: { gte: since } },
      select: {
        model: true,
        subject: true,
        score: true,
        pass: true,
        reasoning: true,
        judgeModel: true,
        latencyMs: true,
        outputTokens: true,
        createdAt: true,
        harnessVersion: true,
        samples: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 120,
    })
  ).map((row) => ({
    ...row,
    score: row.score == null ? null : Number(row.score),
    stale: row.harnessVersion !== CURRENT_HARNESS_VERSION,
    samples: Array.isArray(row.samples) ? (row.samples as { score: number; reasoning: string }[]) : null,
  }))

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
    // The true totals for the window, from an unbounded aggregate — never the
    // sum of `models` below, which is capped at the top 50 by spend.
    total: { costUsd: Number(totalAgg._sum.costUsd ?? 0), calls: totalAgg._count._all },
    // Earliest row actually in the window — may be newer than the requested
    // window's start once the 90-day retention prune has removed older rows.
    dataSince: totalAgg._min.createdAt,
    models,
    bench,
    benchDetail,
    shadow: [...matchups.values()].sort((a, b) => b.samples - a.samples),
    benchRunning: await benchRunning(),
    // What the candidate picker may offer: the model roster filtered to
    // endpoints this deployment has keys for.
    benchable: benchableModels(),
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
