/**
 * The sidebar's "% of credits" number, as a pure function.
 *
 * Extracted so the edge cases — a missing/zero budget, usage at or over the
 * ceiling, non-finite inputs — are pinned by a unit test rather than only
 * visible by staring at a rendered progress bar.
 */
export function creditUsagePct(usedTokens: number, budgetTokens: number | null | undefined): number {
  if (!Number.isFinite(usedTokens) || usedTokens <= 0) return 0
  if (!Number.isFinite(budgetTokens) || !budgetTokens || budgetTokens <= 0) return 0
  return Math.min(100, Math.round((usedTokens / budgetTokens) * 100))
}
