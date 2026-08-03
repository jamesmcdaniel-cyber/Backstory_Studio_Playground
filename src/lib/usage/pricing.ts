/**
 * Model price table, in USD per MILLION tokens.
 *
 * This is for INTERNAL ops visibility, not invoicing — it is not reconciled
 * against provider invoices and is not a billing source of truth. Cost is
 * computed and snapshotted at write time, so bumping PRICE_VERSION never
 * rewrites history.
 *
 * When prices change: update the rates AND bump PRICE_VERSION.
 *
 * Cache rates are derived, not independently published: a cache WRITE bills at
 * 1.25x input (the 5-minute ephemeral TTL this codebase uses — see
 * CACHE_CONTROL in src/lib/llm/model-runner.ts; the 1-hour TTL would be 2x),
 * and a cache READ at ~0.1x input.
 */
import type { TokenUsage } from '@/lib/llm/model-runner'

export const PRICE_VERSION = '2026-08-03'

type Rates = {
  /** Fresh (uncached) input tokens. */
  input: number
  /** Cache writes — 1.25x input at the 5-minute TTL. */
  cacheWrite: number
  /** Cache reads — ~0.1x input. */
  cacheRead: number
  output: number
}

/** Build a rate row from the two published numbers. */
function rates(input: number, output: number): Rates {
  return { input, cacheWrite: input * 1.25, cacheRead: input * 0.1, output }
}

const PER_MILLION: Record<string, Rates> = {
  // Anthropic first-party rates.
  'anthropic:claude-fable-5': rates(10, 50),
  'anthropic:claude-mythos-5': rates(10, 50),
  'anthropic:claude-opus-5': rates(5, 25),
  'anthropic:claude-opus-4-8': rates(5, 25),
  'anthropic:claude-opus-4-7': rates(5, 25),
  'anthropic:claude-opus-4-6': rates(5, 25),
  // Sonnet 5 carries an introductory rate of $2/$10 per MTok through
  // 2026-08-31. We deliberately encode the STANDARD $3/$15 instead: this table
  // is a static constant that may go months without review, and a rate that
  // silently becomes 33% too low on 2026-09-01 is worse for an ops dashboard
  // than one that runs slightly high for a few weeks. Overstating spend is the
  // safe direction here.
  'anthropic:claude-sonnet-5': rates(3, 15),
  'anthropic:claude-sonnet-4-6': rates(3, 15),
  'anthropic:claude-haiku-4-5': rates(1, 5),

  // Voyage embeddings (input only — embeddings produce no output tokens).
  // Not covered by the Anthropic price sheet; verify against Voyage's own
  // pricing page when this materially affects a number you are acting on.
  'voyage:voyage-3': { input: 0.06, cacheWrite: 0.06, cacheRead: 0.06, output: 0 },
  'voyage:voyage-3-lite': { input: 0.02, cacheWrite: 0.02, cacheRead: 0.02, output: 0 },
}

/**
 * Match a model string to a rate row. Exact match first, then longest-prefix —
 * so a dated variant (claude-sonnet-5-20260101) prices as its family rather
 * than falling through to unknown.
 */
function ratesFor(provider: string, model: string): Rates | null {
  const key = `${provider}:${model}`
  if (PER_MILLION[key]) return PER_MILLION[key]

  let best: { length: number; rates: Rates } | null = null
  for (const [candidate, candidateRates] of Object.entries(PER_MILLION)) {
    if (key.startsWith(candidate) && (!best || candidate.length > best.length)) {
      best = { length: candidate.length, rates: candidateRates }
    }
  }
  return best?.rates ?? null
}

/**
 * Cost in USD for one call. An unknown model yields 0 with priceVersion
 * 'unknown' rather than throwing — a newly released model must never break a
 * run, and the flag makes the gap visible in the admin view.
 */
export function computeCostUsd(
  provider: string,
  model: string,
  usage: TokenUsage,
): { costUsd: number; priceVersion: string } {
  const rate = ratesFor(provider, model)
  if (!rate) return { costUsd: 0, priceVersion: 'unknown' }

  const raw =
    (usage.inputTokens * rate.input +
      usage.cacheWriteTokens * rate.cacheWrite +
      usage.cacheReadTokens * rate.cacheRead +
      usage.outputTokens * rate.output) /
    1_000_000

  // Six decimals matches the Decimal(12,6) column; rounding here keeps the
  // stored value and the computed value identical.
  return { costUsd: Math.round(raw * 1e6) / 1e6, priceVersion: PRICE_VERSION }
}
