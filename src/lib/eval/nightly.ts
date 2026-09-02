/**
 * Nightly quality gate. Runs every fixture LIVE against a real model, judges
 * each one several times, and compares the per-fixture means to the committed
 * baseline. Exits non-zero on regression so the workflow can raise an issue.
 *
 * Not a PR gate: it needs a model key and it costs money. Deterministic
 * scripted replay already blocks PRs via `npm test`.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createModelRunner } from '@/lib/llm/model-runner'
import { runLoop, fixtureDispatch, checkTrajectory } from './harness'
import { judgeTrajectory } from './judge'
import { fixtures } from './fixtures'
import { compareToBaseline, type Baseline, type Scorecard } from './baseline'
import type { Trajectory } from './types'

/** Judgements per fixture. Averaging tames the judge's run-to-run variance. */
const SAMPLES = 3

const BASELINE_PATH = join(process.cwd(), 'src/lib/eval/baseline.json')

async function meanScore(fixtureName: string, rubric: string, trajectory: Trajectory): Promise<number> {
  const scores: number[] = []
  for (let i = 0; i < SAMPLES; i += 1) {
    const verdict = await judgeTrajectory(rubric, trajectory)
    scores.push(verdict.score)
  }
  const mean = scores.reduce((total, score) => total + score, 0) / scores.length
  console.log(`  ${fixtureName}: ${scores.map((score) => score.toFixed(2)).join(', ')} → ${mean.toFixed(3)}`)
  return mean
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('No model key configured — set ANTHROPIC_API_KEY.')
    process.exit(1)
  }

  const scorecard: Scorecard = {}
  const structural: string[] = []

  for (const fixture of fixtures) {
    if (!fixture.rubric) {
      console.log(`  ${fixture.name}: skipped (no rubric)`)
      continue
    }
    const runner = createModelRunner(fixture.model)
    const trajectory = await runLoop(runner, fixture, fixtureDispatch(fixture))

    // Deterministic asserts still apply on a live run — a structural break is a
    // failure regardless of what the judge thinks of the prose.
    const problems = checkTrajectory(trajectory, fixture.expect)
    if (problems.length) structural.push(`${fixture.name}: ${problems.join('; ')}`)

    scorecard[fixture.name] = await meanScore(fixture.name, fixture.rubric, trajectory)
  }

  const baseline: Baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  const isFirstRun = Object.keys(baseline).length === 0

  if (isFirstRun) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(scorecard, null, 2)}\n`)
    console.log('\nNo baseline yet — wrote the current scores as the baseline.')
    console.log('Commit src/lib/eval/baseline.json to start gating.')
    return
  }

  const result = compareToBaseline(scorecard, baseline)
  console.log(`\nCorpus mean: ${result.corpusMean.toFixed(3)}`)

  const allFailures = [...structural, ...result.failures]
  if (allFailures.length) {
    console.error('\nEval regressions:')
    for (const failure of allFailures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('All fixtures within tolerance.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
