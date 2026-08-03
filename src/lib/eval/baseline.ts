/**
 * Regression gating for judge-scored evals.
 *
 * JudgeResult.score is a 0..1 float produced by an LLM, so a single sample is
 * too noisy to gate on — the nightly runner averages several judgements per
 * fixture and compares the mean here. Two independent conditions must hold: no
 * fixture may fall far below its own history, and the corpus as a whole must
 * clear an absolute quality bar.
 */

export type Baseline = Record<string, number>
export type Scorecard = Record<string, number>

/** How far a fixture may drift below its baseline before it counts as a regression. */
export const REGRESSION_TOLERANCE = 0.15

/** The corpus mean must stay at or above this regardless of baseline drift. */
export const ABSOLUTE_FLOOR = 0.7

export function compareToBaseline(
  scorecard: Scorecard,
  baseline: Baseline,
): { ok: boolean; failures: string[]; corpusMean: number } {
  const names = Object.keys(scorecard)
  const failures: string[] = []

  if (names.length === 0) {
    // An empty scorecard means the run produced nothing — a broken harness must
    // not read as a clean bill of health.
    return { ok: false, failures: ['no fixtures scored — the eval run produced no results'], corpusMean: 0 }
  }

  for (const name of names) {
    const score = scorecard[name]
    const previous = baseline[name]
    // A brand-new fixture has nothing to regress against; it still counts
    // toward the corpus mean below.
    if (previous === undefined) continue
    if (score < previous - REGRESSION_TOLERANCE) {
      failures.push(
        `${name}: ${score.toFixed(3)} vs baseline ${previous.toFixed(3)} (tolerance ${REGRESSION_TOLERANCE})`,
      )
    }
  }

  const corpusMean = names.reduce((total, name) => total + scorecard[name], 0) / names.length
  if (corpusMean < ABSOLUTE_FLOOR) {
    failures.push(`corpus mean ${corpusMean.toFixed(3)} is below the floor of ${ABSOLUTE_FLOOR}`)
  }

  return { ok: failures.length === 0, failures, corpusMean }
}
