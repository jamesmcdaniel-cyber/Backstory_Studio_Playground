import { after } from 'next/server'
import { apiLogger } from '@/lib/logger'
import type { DecideResult } from '@/lib/agents/approval'
import { resumeAgentExecution } from '@/features/agents/execute-agent'
import { dispatchDetachedFlowExecution } from '@/features/flows/execute-flow'

/**
 * Resume whatever a decision un-paused, after the response. after() (not a
 * bare fire-and-forget promise) keeps a serverless function alive until the
 * resume is enqueued — otherwise the work is dropped and the run strands
 * waiting forever. Shared by the single and the batch decision routes.
 */
export function scheduleApprovalResume({ resume, resumeFlow }: Pick<DecideResult, 'resume' | 'resumeFlow'>): void {
  if (resume) {
    after(async () => {
      try {
        await resumeAgentExecution(resume)
      } catch (error) {
        apiLogger.error('approval resume failed', { executionId: resume.executionId, error: error instanceof Error ? error.message : String(error) })
      }
    })
  }
  // A flow run paused on a tool-step approval resumes the same way. Detached
  // (queued in prod) so a long remaining flow doesn't run inline. With
  // per-item approvals only the LAST decision for a run carries resumeFlow.
  if (resumeFlow) {
    after(async () => {
      try {
        await dispatchDetachedFlowExecution({
          flowId: resumeFlow.flowId,
          organizationId: resumeFlow.organizationId,
          userId: resumeFlow.userId,
          flowRunId: resumeFlow.flowRunId,
          reply: resumeFlow.reply,
          usePublished: resumeFlow.usePublished,
        })
      } catch (error) {
        apiLogger.error('approval flow resume failed', { flowRunId: resumeFlow.flowRunId, error: error instanceof Error ? error.message : String(error) })
      }
    })
  }
}
