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

export type LlmSurface = 'agent_turn' | 'structured' | 'headline' | 'embedding' | 'eval_judge'

export type LlmCallInput = {
  organizationId: string
  surface: LlmSurface
  provider: string
  model: string
  usage: TokenUsage
  agentExecutionId?: string | null
  flowRunId?: string | null
  flowRunStepId?: string | null
}

export async function recordLlmCall(input: LlmCallInput): Promise<void> {
  try {
    const { costUsd, priceVersion } = computeCostUsd(input.provider, input.model, input.usage)

    await systemPrisma.llmCall.create({
      data: {
        organizationId: input.organizationId,
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
        costUsd,
        priceVersion,
      },
    })

    // Rollups only move when there is something to add. An unknown model costs
    // 0, so its detail row is still recorded (and visible as priceVersion
    // 'unknown' in the admin view) without touching the parent totals.
    if (costUsd > 0 && input.agentExecutionId) {
      await systemPrisma.agentExecution.update({
        where: { id: input.agentExecutionId },
        data: { costUsd: { increment: costUsd } },
      })
    }
    if (costUsd > 0 && input.flowRunId) {
      await systemPrisma.flowRun.update({
        where: { id: input.flowRunId },
        data: { costUsd: { increment: costUsd } },
      })
    }
  } catch (error) {
    apiLogger.warn('llm ledger write failed', {
      surface: input.surface,
      model: input.model,
      error: error instanceof Error ? error.message.slice(0, 200) : String(error),
    })
  }
}
