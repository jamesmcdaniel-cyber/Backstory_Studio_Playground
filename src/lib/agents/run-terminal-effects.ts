/**
 * What an agent run owes once it has stopped — for the paths that stop it
 * OUTSIDE the executor.
 *
 * The executor's own failure path (execute-agent.ts) tells the owner, answers
 * the Slack thread that started the run, nudges the live activity feed and
 * reconciles an ROI build. The reaper, the dead-letter terminalizer, the
 * stuck-approval sweep and a user's cancel of a paused run all end a run with
 * a bare status write, so none of that happened: a Slack placeholder read
 * "is on it…" forever, nobody heard the run died, and an approval it left
 * pending stayed approvable — approving it would run a write for a run that
 * no longer exists.
 *
 * Called once per run the caller actually moved. Best-effort (every effect is
 * fenced; nothing throws into the caller), idempotent (it re-reads the row and
 * acts only when it still says the status it was called for; superseding is a
 * no-op the second time), and bounded for sweeps (onAgentRunsTerminalized).
 */

import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { ambientOrganization } from '@/lib/tenant-database-context'
import { broadcastAgentEventTick } from '@/lib/flows/run-stream'
import { notify } from '@/lib/notifications/service'

/** Most runs one sweep follows up on; the rest still end, just without the follow-up. */
export const AGENT_TERMINAL_EFFECTS_BATCH_LIMIT = 100

type TerminalStatus = 'failed' | 'cancelled'

export interface AgentTerminalOptions {
  /** Skip the owner notification — the caller already sent its own. */
  skipNotify?: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fenced(label: string, executionId: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    apiLogger.error(`agent terminal effect failed: ${label}`, { executionId, error: errorMessage(error) })
  }
}

/** Supersede every approval a run left pending. Safe to repeat. */
export async function supersedePendingApprovals(organizationId: string, executionId: string): Promise<number> {
  const result = await prisma.approvalRequest.updateMany({
    where: { organizationId, executionId, status: 'pending' },
    data: { status: 'superseded' },
  })
  return result.count
}

export async function onAgentRunTerminalized(
  params: { executionId: string; status: TerminalStatus },
  options: AgentTerminalOptions = {},
): Promise<void> {
  const { executionId, status } = params
  // systemPrisma: id-keyed read of a run a caller just terminalized itself;
  // reapers and dead-letter terminalizers hold no tenant context. Every write
  // below is scoped to the organization read here.
  const execution = await systemPrisma.agentExecution
    .findUnique({
      where: { id: executionId },
      select: {
        id: true,
        organizationId: true,
        userId: true,
        status: true,
        error: true,
        trigger: true,
        metadata: true,
        agentTaskId: true,
        agentTask: { select: { description: true } },
      },
    })
    .catch(() => null)
  // Idempotency: a run a late finish already overwrote had its own follow-up.
  if (!execution || execution.status !== status) return
  const organizationId = execution.organizationId
  const title = ((execution.metadata as { title?: unknown } | null)?.title as string | undefined) || execution.agentTask?.description || 'Agent'
  const error = execution.error || (status === 'cancelled' ? 'Run cancelled.' : 'The run failed.')
  const trigger = execution.trigger as { type?: unknown; link?: unknown } | null

  await ambientOrganization.run(organizationId, async () => {
    await fenced('approvals', executionId, () => supersedePendingApprovals(organizationId, executionId))
    // A Slack-started run answers its thread instead of leaving the
    // placeholder saying it is still working.
    await fenced('slack', executionId, async () => {
      const { finishSlackMentionForExecution } = await import('@/lib/slack/reply')
      await finishSlackMentionForExecution(
        executionId,
        status === 'cancelled' ? 'That run was cancelled.' : `That run failed. ${error.slice(0, 300)}`,
      )
    })
    if (status === 'failed') {
      if (!options.skipNotify) {
        await fenced('notify', executionId, () => notify({
          organizationId,
          userId: execution.userId,
          type: 'agent.error',
          level: 'error',
          title: `${title} hit an error`,
          body: error,
          ...(execution.agentTaskId ? { agentTaskId: execution.agentTaskId } : {}),
          executionId,
          ...(typeof trigger?.link === 'string' && trigger.link.startsWith('/') ? { link: trigger.link } : {}),
        }))
      }
      if (trigger?.type === 'roi_analysis') {
        await fenced('roi reconcile', executionId, async () => {
          const { reconcileRoiAnalysisForExecution } = await import('@/lib/roi/service')
          await reconcileRoiAnalysisForExecution(organizationId, executionId)
        })
      }
    }
    broadcastAgentEventTick(executionId)
  })
}

/** onAgentRunTerminalized for a sweep's worth of runs: sequential, capped, never throws. */
export async function onAgentRunsTerminalized(executionIds: string[], status: TerminalStatus): Promise<void> {
  for (const executionId of executionIds.slice(0, AGENT_TERMINAL_EFFECTS_BATCH_LIMIT)) {
    await onAgentRunTerminalized({ executionId, status }).catch((error) => {
      apiLogger.error('agent terminal effects failed', { executionId, error: errorMessage(error) })
    })
  }
}
