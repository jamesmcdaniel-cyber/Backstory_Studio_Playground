import { prisma } from '@/lib/prisma'

/**
 * Keep a run's approvals honest with the run, once it has settled for now.
 *
 * Steps re-attach to their own pending approval across resumes (per-item
 * approvals — see src/lib/flows/item-approval.ts), so the resume path no
 * longer supersedes every pending request blindly. This is the other half:
 *
 *  - a run that is no longer waiting (finished, failed, cancelled) supersedes
 *    every approval it left pending — approving one now would execute a write
 *    no step will ever consume;
 *  - a waiting run supersedes the pending approvals no waiting step is paused
 *    on any more, and
 *  - reports when every approval its waiting steps ARE paused on has already
 *    been decided. That happens when the decisions land while the run is still
 *    `running` (a long per-item container keeps working on other items):
 *    decideApproval only resumes a `waiting` run, so without this nobody would.
 *    The caller resumes with the returned reply.
 *
 * Best-effort by contract: a failure here never changes how the run ended.
 */
export async function settleRunApprovals(params: {
  organizationId: string
  runId: string
  status: string
}): Promise<{ resumeReply?: string }> {
  const { organizationId, runId, status } = params
  if (status !== 'waiting') {
    await prisma.approvalRequest.updateMany({
      where: { organizationId, executionId: runId, status: 'pending' },
      data: { status: 'superseded' },
    })
    return {}
  }

  const waiting = await prisma.flowRunStep.findMany({
    where: { flowRunId: runId, status: 'waiting' },
    select: { output: true },
  })
  const live = [...new Set(
    waiting
      .map((step) => (step.output as { waiting?: { kind?: string; approvalId?: unknown } } | null)?.waiting)
      .filter((info) => info?.kind === 'approval' && typeof info.approvalId === 'string')
      .map((info) => info!.approvalId as string),
  )]
  await prisma.approvalRequest.updateMany({
    where: { organizationId, executionId: runId, status: 'pending', ...(live.length ? { id: { notIn: live } } : {}) },
    data: { status: 'superseded' },
  })
  if (!live.length) return {}

  const rows = await prisma.approvalRequest.findMany({
    where: { organizationId, id: { in: live } },
    select: { id: true, status: true },
  })
  if (rows.some((row) => row.status === 'pending' || row.status === 'approving')) return {}
  const decided = rows.find((row) => row.status === 'approved' || row.status === 'rejected' || row.status === 'failed')
  if (!decided) return {}
  // The reply only wakes the run; each step reads its own decision from its row.
  return { resumeReply: JSON.stringify({ status: decided.status === 'rejected' ? 'rejected' : 'approved', approvalId: decided.id }) }
}
