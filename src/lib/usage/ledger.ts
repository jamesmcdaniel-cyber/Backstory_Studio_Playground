/**
 * Per-call cost ledger. Writes one LlmCall detail row and increments the
 * denormalized total on its parent execution/run.
 *
 * BEST EFFORT: a ledger failure is logged and swallowed, never thrown. A
 * dropped row under-reports cost; a run failing because billing telemetry
 * hiccuped is unacceptable. Same posture as recordTokenUsage.
 *
 * systemPrisma throughout: this runs inside the worker, outside any request's
 * org context, and writes rows for whichever org the run belongs to.
 */
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import type { TokenUsage } from '@/lib/llm/model-runner'
import { computeCostUsd } from './pricing'

export type LlmSurface =
  | 'agent_turn'
  | 'structured'
  | 'headline'
  | 'embedding'
  | 'eval_judge'
  | 'shadow_eval'
  // A flow's standalone 'ai' step — distinct from 'agent_turn' (the agent
  // runtime's own turns) so per-surface cost breakdowns don't conflate the two.
  | 'flow_ai'
  // Consumed by the eval bench runner (a later task); added here only so the
  // union carries it from the start.
  | 'eval_bench'

export type LlmCallInput = {
  organizationId: string
  /** The run's owner. Null for system dispatch, and for pre-attribution rows. */
  userId?: string | null
  surface: LlmSurface
  provider: string
  model: string
  usage: TokenUsage
  /**
   * Wall-clock for the call. Optional: an omitted latency is stored as NULL and
   * excluded from the console's averages, which is the honest reading — a zero
   * would drag every model's mean toward instant.
   */
  latencyMs?: number | null
  agentExecutionId?: string | null
  flowRunId?: string | null
  flowRunStepId?: string | null
}

/**
 * The slice of PrismaClient recordLlmCall needs, expressed as a structural type
 * so a unit test can hand in a plain object that fakes `$transaction` — no
 * mocking framework required. Defaults to the real systemPrisma in production.
 */
type LedgerPrismaClient = {
  $transaction: <T>(fn: (tx: LedgerTransactionClient) => Promise<T>) => Promise<T>
}
type LedgerTransactionClient = {
  llmCall: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> }
  agentExecution: { update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> }
  flowRun: { update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown> }
}

export async function recordLlmCall(
  input: LlmCallInput,
  // Cast rather than widen LedgerPrismaClient: PrismaClient's real
  // `$transaction` is overloaded (array form + callback form), which TS
  // cannot structurally match against our single-signature callback-only
  // type even though the callback form is always the one taken here.
  client: LedgerPrismaClient = systemPrisma as unknown as LedgerPrismaClient,
): Promise<void> {
  try {
    const { costUsd, priceVersion } = computeCostUsd(input.provider, input.model, input.usage)

    // Detail row + rollup increments in one transaction: a mid-write crash must
    // never leave a detail row on record with no matching bump to its parent's
    // total (or vice versa) — the two are one fact, not two.
    await client.$transaction(async (tx) => {
      await tx.llmCall.create({
        data: {
          organizationId: input.organizationId,
          userId: input.userId ?? null,
          agentExecutionId: input.agentExecutionId ?? null,
          flowRunId: input.flowRunId ?? null,
          flowRunStepId: input.flowRunStepId ?? null,
          surface: input.surface,
          provider: input.provider,
          model: input.model,
          inputTokens: input.usage.inputTokens,
          cacheWriteTokens: input.usage.cacheWriteTokens,
          cacheReadTokens: input.usage.cacheReadTokens,
          outputTokens: input.usage.outputTokens,
          latencyMs: input.latencyMs ?? null,
          costUsd,
          priceVersion,
        },
      })

      // Rollups only move when there is something to add. An unknown model costs
      // 0, so its detail row is still recorded (and visible as priceVersion
      // 'unknown' in the admin view) without touching the parent totals.
      if (costUsd > 0 && input.agentExecutionId) {
        await tx.agentExecution.update({
          where: { id: input.agentExecutionId },
          data: { costUsd: { increment: costUsd } },
        })
      }
      if (costUsd > 0 && input.flowRunId) {
        await tx.flowRun.update({
          where: { id: input.flowRunId },
          data: { costUsd: { increment: costUsd } },
        })
      }
    })
  } catch (error) {
    apiLogger.warn('llm ledger write failed', {
      surface: input.surface,
      model: input.model,
      // Whatever attribution the call carried — the only context available
      // once the write itself has failed — so a dropped row can still be
      // traced back to the run/step/execution it belonged to.
      organizationId: input.organizationId,
      agentExecutionId: input.agentExecutionId ?? null,
      flowRunId: input.flowRunId ?? null,
      flowRunStepId: input.flowRunStepId ?? null,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
  }
}
