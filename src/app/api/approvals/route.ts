import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { approvalItemOf } from '@/lib/flows/item-approval'

// Where an approval came from, resolved from its ambiguous executionId (which
// holds EITHER an AgentExecution id OR a FlowRun id — no discriminator on the
// row). Resolved per page via two indexed IN-queries, both org-scoped.
type ApprovalSource = { kind: 'flow'; flowId: string; flowName: string } | { kind: 'agent'; agentId: string | null } | null

const DEFAULT_TAKE = 50
const MAX_TAKE = 100

function intParam(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

// Outbound-write approvals for this workspace.
//   status=a,b   comma-separated set of statuses (default: pending)
//   skip/take    offset pagination, newest-first; take capped at 100
// Response: { success, approvals, hasMore } — hasMore drives "Load more".
// Each approval carries `item` ({ index, count, label }) when a flow step in a
// per-item container asked for it, so the inbox can name the item and group a
// run's approvals together (they share `executionId`).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const params = request.nextUrl.searchParams
  const statusList = (params.get('status') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const take = Math.min(Math.max(intParam(params.get('take'), DEFAULT_TAKE), 1), MAX_TAKE)
  // Upper-bounded: an absurd skip (1e20) is finite, passes a bare >=0 clamp,
  // and overflows the query engine's i64 into a 500.
  const skip = Math.min(Math.max(intParam(params.get('skip'), 0), 0), 1_000_000)

  // Fetch one extra row purely to learn whether another page exists.
  const page = await prisma.approvalRequest.findMany({
    where: { organizationId: auth.organizationId, status: { in: statusList.length ? statusList : ['pending'] } },
    orderBy: { createdAt: 'desc' },
    skip,
    take: take + 1,
    select: { id: true, tool: true, summary: true, status: true, createdAt: true, executionId: true, payload: true },
  })
  const hasMore = page.length > take
  const rows = hasMore ? page.slice(0, take) : page

  const executionIds = [...new Set(rows.map((row) => row.executionId))]
  const [flowRuns, agentExecutions] = executionIds.length
    ? await Promise.all([
        prisma.flowRun.findMany({
          where: { id: { in: executionIds }, organizationId: auth.organizationId },
          select: { id: true, flowId: true, flow: { select: { name: true } } },
        }),
        prisma.agentExecution.findMany({
          where: { id: { in: executionIds }, organizationId: auth.organizationId },
          select: { id: true, agentTaskId: true },
        }),
      ])
    : [[], []]
  const flowByRunId = new Map(flowRuns.map((run) => [run.id, { flowId: run.flowId, flowName: run.flow?.name ?? '' }]))
  const agentIdByExecutionId = new Map(agentExecutions.map((execution) => [execution.id, execution.agentTaskId]))

  const approvals = rows.map(({ payload, ...row }) => {
    const flow = flowByRunId.get(row.executionId)
    const source: ApprovalSource = flow
      ? { kind: 'flow', ...flow }
      : agentIdByExecutionId.has(row.executionId)
        ? { kind: 'agent', agentId: agentIdByExecutionId.get(row.executionId) ?? null }
        : null
    // Only the item label leaves the payload — never the call's arguments.
    return { ...row, item: approvalItemOf(payload), source }
  })
  return { success: true, approvals, hasMore }
}, { permission: 'agent.read' })
