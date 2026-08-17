import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { inlineExecution } from '@/lib/queue/execution-mode'
import type { AgentExecutionJob } from './execute-agent'

/**
 * Hand an agent run to the worker (or run it here in inline mode).
 *
 * The scheduler used to call `runAgentExecution` DIRECTLY, inside the cron HTTP
 * request, serially, for up to 25 agents under an 1800s ceiling — so one slow
 * multi-turn run starved every other due agent in the tick, and a tick that ran
 * long was killed mid-run. Enqueueing instead means a burst of due schedules
 * costs the request one `queue.add` per agent and the runs execute on the pool
 * that is actually built for them.
 *
 * `runAgentExecution` is imported dynamically on the inline path only: it pulls
 * in the whole agent runtime (model SDKs, tool planes, MCP transports), which
 * has no business being in a serverless bundle that is only going to enqueue.
 */
export async function dispatchAgentExecution(
  job: AgentExecutionJob & { executionId: string },
  options: { queue?: string } = {},
): Promise<{ queued: boolean }> {
  if (inlineExecution) {
    const { runAgentExecution } = await import('./execute-agent')
    await runAgentExecution({
      executionId: job.executionId,
      agentId: job.agentId,
      organizationId: job.organizationId,
      userId: job.userId,
      input: job.input ?? '',
    })
    return { queued: false }
  }

  if (!workersEnabled) throw new Error('Agent worker is disabled')

  const queue = createQueue(options.queue ?? QUEUE_NAMES.AGENT_EXECUTION)
  // jobId = executionId makes the enqueue idempotent: a retried cron tick that
  // re-dispatches the same execution row is a no-op rather than a double run.
  await queue.add('execute-agent', job, { jobId: job.executionId })
  return { queued: true }
}
