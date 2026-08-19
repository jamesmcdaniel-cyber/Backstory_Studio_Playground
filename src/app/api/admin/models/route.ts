import { systemPrisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { MODEL_LIMITS } from '@/lib/usage/model-tiers'

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
  }))

  return {
    success: true,
    days,
    models,
    // Shipped with the table so the tab can state the ceilings it is reporting
    // against, rather than the reader holding two numbers in their head.
    limits: MODEL_LIMITS,
  }
}, { permission: 'platform.administer', internalOnly: true })
