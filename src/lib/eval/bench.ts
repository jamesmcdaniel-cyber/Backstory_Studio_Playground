/**
 * Cross-model bench: the SAME fixtures, run against every candidate model, so
 * "can a cheaper model do this job" is answered by measurement instead of
 * vibes. Results persist to model_eval_results, which the Admin → Models tab
 * reads — this is the harness behind that panel's Quality section.
 *
 * Differs from nightly.ts on three axes, deliberately:
 *  - nightly runs ONE model per fixture and gates on a committed baseline
 *    (regression detection); bench runs N models on identical fixtures
 *    (comparison). Both reuse the same loop, fixtures, and judge.
 *  - bench runners are PINNED (createPinnedRunner): a candidate that falls
 *    back mid-run would score another model's answer under its own name.
 *  - the judge is pinned to ONE model for every candidate. A judge is itself a
 *    model with tastes; letting provider selection pick it per-call would let
 *    Qwen grade its own homework whenever it is the configured provider.
 *
 * Two entry points, one implementation: the "Run bench" button in Admin →
 * Models enqueues a model-bench job the worker drives through runBench(), and
 * `BENCH_MODELS=... npm run eval:bench` calls the same function from a shell.
 * Costs real tokens and needs DATABASE_URL — an operator tool, never a PR gate.
 */
import { createPinnedRunner, DEFAULT_AGENT_MODEL } from '@/lib/llm/model-runner'
import { qwenConfigured, qwenModel } from '@/lib/llm/qwen'
import { modelProviderBrand } from '@/lib/llm/provider-brand'
import { runLoop, cannedDispatch, checkTrajectory } from './harness'
import { judgeTrajectory, pinnedJudgeModel } from './judge'
import { fixtures } from './fixtures'
import type { Trajectory } from './types'

/** Judgements per fixture per model — averaging tames judge variance. */
const SAMPLES = 3

/**
 * Which models this bench run covers. Pure so the filtering rule is testable:
 * BENCH_MODELS wins when set; either way, models whose endpoint has no key are
 * dropped rather than failed, so one unconfigured provider does not kill the
 * whole run.
 */
export function resolveBenchModels(input: {
  env: string | undefined
  anthropic: boolean
  qwen: boolean
}): string[] {
  const requested = (input.env ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const candidates = requested.length ? requested : [DEFAULT_AGENT_MODEL, 'qwen-3.7']
  return [...new Set(candidates)].filter((model) =>
    model.startsWith('claude') ? input.anthropic : input.qwen,
  )
}

function providerOf(model: string): string {
  return modelProviderBrand(model)?.slug === 'qwen' ? 'qwen' : 'anthropic'
}

async function meanJudgement(rubric: string, trajectory: Trajectory): Promise<{ score: number; reasoning: string }> {
  const judge = pinnedJudgeModel()
  const scores: number[] = []
  let reasoning = ''
  for (let i = 0; i < SAMPLES; i += 1) {
    const verdict = await judgeTrajectory(rubric, trajectory, { judgeModel: judge })
    scores.push(verdict.score)
    reasoning = verdict.reasoning
  }
  return { score: scores.reduce((total, score) => total + score, 0) / scores.length, reasoning }
}

export type BenchSummary = {
  models: string[]
  judge: string
  /** fixture results actually persisted */
  recorded: number
  /** candidate/fixture attempts that errored (dead endpoint, judge failure) */
  errors: number
}

/**
 * Run the full bench and persist every result. Throws only when NOTHING is
 * benchable (no configured candidate); per-fixture errors are counted and
 * logged so one dead endpoint fails its candidate loudly without killing the
 * others. `log` defaults to console so the CLI output is unchanged.
 */
export async function runBench(log: (line: string) => void = console.log): Promise<BenchSummary> {
  const models = resolveBenchModels({
    env: process.env.BENCH_MODELS,
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    qwen: qwenConfigured(),
  })
  if (!models.length) {
    throw new Error('No benchable model configured — set ANTHROPIC_API_KEY and/or QWEN_API_KEY (+QWEN_BASE_URL).')
  }
  // Imported lazily so the pure helpers above stay importable in DB-less tests.
  const { systemPrisma } = await import('@/lib/prisma')
  const judge = pinnedJudgeModel()
  const summary: BenchSummary = { models, judge, recorded: 0, errors: 0 }
  log(`Bench: ${models.join(', ')} — judged by ${judge}`)

  for (const model of models) {
    // Qwen candidates resolve through QWEN_MODEL exactly as production does,
    // so the bench measures the model production would actually serve.
    const served = model.startsWith('claude') ? model : qwenModel(model)
    log(`${model}${served === model ? '' : ` (served as ${served})`}:`)
    for (const fixture of fixtures) {
      if (!fixture.rubric) continue
      const runner = createPinnedRunner(served)
      const startedAt = Date.now()
      try {
        const trajectory = await runLoop(runner, fixture, cannedDispatch(fixture.toolResponses))
        const structural = checkTrajectory(trajectory, fixture.expect)
        const { score, reasoning } = await meanJudgement(fixture.rubric, trajectory)
        await systemPrisma.modelEvalResult.create({
          data: {
            kind: 'bench',
            provider: providerOf(model),
            model: served,
            subject: fixture.name,
            score,
            pass: structural.length === 0,
            // Bench inputs are checked-in fixtures we authored, so keeping the
            // judge's sentence is safe here — and only here (see the model doc).
            reasoning: structural.length ? `structural: ${structural.join('; ')} — ${reasoning}` : reasoning,
            judgeModel: judge,
            inputTokens: trajectory.usage.inputTokens,
            outputTokens: trajectory.usage.outputTokens,
            latencyMs: Date.now() - startedAt,
          },
        })
        summary.recorded += 1
        log(`  ${fixture.name}: ${score.toFixed(3)}${structural.length ? ' STRUCTURAL-FAIL' : ''}`)
      } catch (error) {
        // A pinned run has no fallback by design; a dead endpoint fails its
        // candidate loudly instead of polluting the table with silent gaps.
        summary.errors += 1
        log(`  ${fixture.name}: ERROR — ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return summary
}

// Only execute as a script — importing runBench must never start a run.
if (process.argv[1]?.endsWith('bench.ts')) {
  void runBench()
    .then((summary) => process.exit(summary.errors > 0 ? 1 : 0))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
