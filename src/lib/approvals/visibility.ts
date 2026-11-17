/**
 * Who may see — and decide — an approval, and whether its run is still alive.
 *
 * An ApprovalRequest has no owner columns of its own: its `executionId` names
 * EITHER an AgentExecution (an agent's write) or a FlowRun (a flow tool step's
 * write), with no discriminator. So its visibility is its run's, and its run's
 * is its agent's or flow's — the same rule every other run surface applies
 * (executionVisibilityScope, the action ledger's visibleLedgerWhere): a
 * PRIVATE agent or flow is its owner's alone. The inbox used to list every
 * pending row in the workspace, naming private flows, and anyone could approve
 * one — executing the write with the requester's connection.
 */

import { prisma } from '@/lib/prisma'
import { isTerminalRunStatus } from '@/lib/agents/run-status'

type Owned = { visibility: string; userId: string | null } | null | undefined

function hiddenFrom(owner: Owned, userId: string): boolean {
  return Boolean(owner && owner.visibility === 'private' && owner.userId !== userId)
}

/**
 * The run ids, among `executionIds`, whose agent or flow is private to someone
 * other than `userId`. Approvals on those runs are invisible to this person.
 * A run that no longer exists hides nothing — there is no owner left to
 * protect, and the row is history.
 */
export async function hiddenApprovalExecutionIds(
  organizationId: string,
  userId: string,
  executionIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(executionIds)]
  if (!ids.length) return new Set()
  const [flowRuns, executions] = await Promise.all([
    prisma.flowRun.findMany({
      where: { id: { in: ids }, organizationId },
      select: { id: true, flow: { select: { visibility: true, userId: true } } },
    }),
    prisma.agentExecution.findMany({
      where: { id: { in: ids }, organizationId },
      select: { id: true, agentTask: { select: { visibility: true, userId: true } } },
    }),
  ])
  const hidden = new Set<string>()
  for (const run of flowRuns) if (hiddenFrom(run.flow, userId)) hidden.add(run.id)
  for (const execution of executions) if (hiddenFrom(execution.agentTask, userId)) hidden.add(execution.id)
  return hidden
}

/**
 * The inbox's filter: every approval of `statuses` in the org whose run this
 * person may see. Returned as an `executionId` constraint so pagination
 * (skip/take, "Load more") stays exact — filtering a page after the query
 * would hand back short pages and shift the next page's offset.
 */
export async function visibleApprovalWhere(
  organizationId: string,
  userId: string,
  statuses: readonly string[],
): Promise<{ organizationId: string; status: { in: string[] }; executionId?: { notIn: string[] } }> {
  const base = { organizationId, status: { in: [...statuses] } }
  const candidates = await prisma.approvalRequest.findMany({
    where: base,
    distinct: ['executionId'],
    select: { executionId: true },
  })
  const hidden = await hiddenApprovalExecutionIds(organizationId, userId, candidates.map((row) => row.executionId))
  return hidden.size ? { ...base, executionId: { notIn: [...hidden] } } : base
}

/**
 * Whether the run an approval belongs to has stopped for good — finished,
 * failed, cancelled (or being cancelled), or gone. Deciding such an approval
 * would execute a write no step will ever consume.
 */
export async function approvalRunEnded(
  organizationId: string,
  executionId: string,
): Promise<{ ended: boolean; status: string | null }> {
  const [flowRun, execution] = await Promise.all([
    prisma.flowRun.findFirst({ where: { id: executionId, organizationId }, select: { status: true } }),
    prisma.agentExecution.findFirst({ where: { id: executionId, organizationId }, select: { status: true } }),
  ])
  if (flowRun) {
    return { ended: !['running', 'waiting'].includes(flowRun.status), status: flowRun.status }
  }
  if (execution) {
    return { ended: execution.status === 'cancelling' || isTerminalRunStatus(execution.status), status: execution.status }
  }
  return { ended: true, status: null }
}
