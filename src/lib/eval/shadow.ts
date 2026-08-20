/**
 * Shadow comparison: on a sampled fraction of REAL production tasks, run the
 * same prompt through a challenger model, judge the two answers blind, and
 * store the scores. This is the strongest evidence in the "can a cheaper model
 * do this job" question — real work, not fixtures — and it feeds the same
 * model_eval_results table the bench does.
 *
 * ── Scope: side-effect-free surfaces ONLY ─────────────────────────────────
 *
 * A flow `ai` step is pure text→text, so re-running its prompt is harmless.
 * Agent runs with tools are OUT of scope by design: re-running one would fire
 * its side effects twice (the email sends again), and replaying it against the
 * recorded tool results breaks the moment the challenger calls a different
 * tool. If that comparison is ever wanted, it is a research project, not a
 * sampling flag.
 *
 * ── Privacy and spend posture ─────────────────────────────────────────────
 *
 * The challenger and the judge both see tenant text, so the operation records
 * PII egress like any other model call. What is STORED is scores and token
 * counts only — never the text, and never the judge's reasoning, which could
 * quote it. The challenger's spend is written to the LlmCall ledger (surface
 * 'shadow_eval') so operators see it, but is NOT counted against the
 * workspace's monthly token ceiling: the platform initiated this call, not the
 * customer, and their budget should not shrink for our measurement.
 *
 * Off by default: SHADOW_EVAL_RATE=0 unless an operator sets it.
 */
import { randomUUID } from 'node:crypto'
import { createPinnedRunner, generateStructured } from '@/lib/llm/model-runner'
import { qwenModel } from '@/lib/llm/qwen'
import { fenceUntrusted, UNTRUSTED_DATA_RULE } from '@/lib/security/prompt'
import { recordPiiEgress } from '@/lib/usage/ai-guard'
import { computeCostUsd } from '@/lib/usage/pricing'
import { apiLogger } from '@/lib/logger'
import { pinnedJudgeModel } from './judge'

export type ShadowConfig = { rate: number; model: string }

/**
 * Pure config resolution: null means shadowing is off — unset model, or a rate
 * that is missing, non-numeric, or non-positive. The rate is clamped to [0,1]
 * so a fat-fingered "5" samples everything rather than 500%.
 */
export function shadowConfig(env: { rate: string | undefined; model: string | undefined }): ShadowConfig | null {
  const model = env.model?.trim()
  if (!model) return null
  const rate = Number(env.rate)
  if (!Number.isFinite(rate) || rate <= 0) return null
  return { rate: Math.min(1, rate), model }
}

/** Split from the RNG so the decision rule is testable at the boundaries. */
export function shouldSample(rate: number, roll: number): boolean {
  return roll < rate
}

const PAIR_JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    a_score: { type: 'number', description: 'Quality of answer A against the task, 0 to 1.' },
    b_score: { type: 'number', description: 'Quality of answer B against the task, 0 to 1.' },
  },
  required: ['a_score', 'b_score'],
} as const

const clamp = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null

/**
 * Judge two answers to one task, blind. The caller randomizes which side is A:
 * judges measurably favor position, and a fixed "champion first" ordering
 * would bias every stored pair the same direction.
 */
export async function judgePair(input: {
  task: string
  answerA: string
  answerB: string
  organizationId: string
  userId?: string | null
}): Promise<{ a: number; b: number } | null> {
  const raw = await generateStructured({
    schemaName: 'shadow_pair_judgment',
    schema: PAIR_JUDGE_SCHEMA as unknown as Record<string, unknown>,
    model: pinnedJudgeModel(),
    maxTokens: 256,
    system:
      'You grade two candidate answers to the same task, independently, each from 0 (useless) to 1 (excellent). ' +
      'Judge only how well each answer serves the task: correctness, completeness, and fitness of form. ' +
      'Do not reward length, and do not assume either answer is the reference.\n\n' +
      UNTRUSTED_DATA_RULE,
    user: [
      fenceUntrusted('task', input.task),
      fenceUntrusted('answer A', input.answerA),
      fenceUntrusted('answer B', input.answerB),
    ].join('\n\n'),
    ledger: { organizationId: input.organizationId, userId: input.userId, surface: 'eval_judge' },
  })
  const parsed = JSON.parse(raw) as { a_score?: unknown; b_score?: unknown }
  const a = clamp(parsed.a_score)
  const b = clamp(parsed.b_score)
  return a == null || b == null ? null : { a, b }
}

/**
 * Maybe shadow one completed flow AI step. Fire-and-forget: every failure is
 * logged and swallowed, because a measurement must never break the run it
 * measures. The caller has already passed the org's AI egress gate this run.
 */
export async function maybeShadowFlowAiStep(input: {
  organizationId: string
  userId: string | null
  flowRunId: string
  system: string
  user: string
  championText: string
  championProvider: string
  championModel: string
}): Promise<void> {
  try {
    const config = shadowConfig({ rate: process.env.SHADOW_EVAL_RATE, model: process.env.SHADOW_EVAL_MODEL })
    if (!config || !input.championText.trim()) return
    if (!shouldSample(config.rate, Math.random())) return

    const challengerModel = config.model.startsWith('claude') ? config.model : qwenModel(config.model)
    // Champion vs itself measures judge noise, not model quality.
    if (challengerModel === input.championModel) return

    // Tenant text leaves for the challenger's endpoint (and the judge's) —
    // recorded exactly like every other egress, under its own surface.
    void recordPiiEgress({
      organizationId: input.organizationId,
      userId: input.userId,
      surface: 'shadow_eval',
      text: input.user,
    })

    const runner = createPinnedRunner(challengerModel)
    const startedAt = Date.now()
    const turn = await runner.next(runner.start(input.user), input.system, [], {
      organizationId: input.organizationId,
      userId: input.userId,
      surface: 'shadow_eval',
      flowRunId: input.flowRunId,
    })
    const latencyMs = Date.now() - startedAt
    if (!turn.text.trim()) return

    // Coin-flip which side is A — see judgePair.
    const championIsA = Math.random() < 0.5
    const scores = await judgePair({
      task: `${input.system}\n\n${input.user}`,
      answerA: championIsA ? input.championText : turn.text,
      answerB: championIsA ? turn.text : input.championText,
      organizationId: input.organizationId,
      userId: input.userId,
    })
    if (!scores) return
    const championScore = championIsA ? scores.a : scores.b
    const challengerScore = championIsA ? scores.b : scores.a

    const pairId = randomUUID()
    const judgeModel = pinnedJudgeModel()
    const { systemPrisma } = await import('@/lib/prisma')
    // Scores and counts only — no text on either row, ever (see the model doc).
    await systemPrisma.modelEvalResult.createMany({
      data: [
        {
          kind: 'shadow',
          provider: input.championProvider,
          model: input.championModel,
          subject: 'flow.ai_step',
          score: championScore,
          judgeModel,
          pairId,
          champion: true,
          organizationId: input.organizationId,
        },
        {
          kind: 'shadow',
          provider: turn.provider,
          model: turn.servedModel,
          subject: 'flow.ai_step',
          score: challengerScore,
          judgeModel,
          pairId,
          champion: false,
          inputTokens: turn.usage.inputTokens + turn.usage.cacheReadTokens + turn.usage.cacheWriteTokens,
          outputTokens: turn.usage.outputTokens,
          latencyMs,
          costUsd: computeCostUsd(turn.provider, turn.servedModel, turn.usage).costUsd,
          organizationId: input.organizationId,
        },
      ],
    })
  } catch (error) {
    apiLogger.warn('shadow eval failed (run unaffected)', {
      flowRunId: input.flowRunId,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
  }
}
