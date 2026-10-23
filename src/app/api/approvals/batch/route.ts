import { z } from 'zod'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { decideApproval, type DecideResult } from '@/lib/agents/approval'
import { scheduleApprovalResume } from '../resume'

const schema = z.object({
  ids: z.array(z.string().min(1).max(64)).min(1).max(100),
  decision: z.enum(['approve', 'reject']),
})

export const runtime = 'nodejs'
export const maxDuration = 1800

// POST /api/approvals/batch — approve all / reject all: one decision applied to
// several approvals (the inbox sends a run's pending per-item approvals). Each
// goes through decideApproval exactly as a single decision does — atomic claim,
// execution, audit — in order, so an approved write still runs once. Per-item
// approvals resume their run only on the last decision, so a run resumes once.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { ids, decision } = schema.parse(await request.json())
  const results: Array<{ id: string; status: DecideResult['status'] | 'not_found' | 'error'; executed?: boolean; error?: string }> = []
  const resumes = new Map<string, Pick<DecideResult, 'resume' | 'resumeFlow'>>()
  for (const id of [...new Set(ids)]) {
    try {
      const { resume, resumeFlow, ...result } = await decideApproval({
        approvalId: id,
        organizationId: auth.organizationId,
        deciderUserId: auth.dbUser.id,
        approve: decision === 'approve',
      })
      results.push({ id, status: result.status, executed: result.executed })
      if (resume) resumes.set(`agent:${resume.executionId}`, { resume })
      if (resumeFlow) resumes.set(`flow:${resumeFlow.flowRunId}`, { resumeFlow })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push(message === 'Approval not found' ? { id, status: 'not_found' } : { id, status: 'error', error: message.slice(0, 300) })
    }
  }
  for (const pending of resumes.values()) scheduleApprovalResume(pending)
  return { success: true, results }
}, { permission: 'agent.run' })
