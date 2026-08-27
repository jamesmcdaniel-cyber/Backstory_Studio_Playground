import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { dispatchDetachedFlowExecution } from '@/features/flows/execute-flow'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { executionVisibilityScope, agentVisibilityScope } from '@/lib/server/visibility'
import { deriveRunWaitingAll } from '@/lib/flows/run-waiting'
import { resolveReplyTarget, type ReplyTarget } from '@/lib/flows/reply-target'
import { injectTraceContext } from '@/lib/observability/otel'

export const runtime = 'nodejs'
export const maxDuration = 1800

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Execution id is required')
  const { message } = z.object({ message: z.string().min(1).max(8000) }).parse(await request.json())

  const execution = await prisma.agentExecution.findFirst({
    where: { id, organizationId: auth.organizationId, ...executionVisibilityScope(auth.dbUser.id) },
  })
  if (!execution) throw new ApiError('Execution not found', 404, 'NOT_FOUND')

  // Cross-path coherence: if this execution is a FLOW's paused agent step,
  // replying from the agent activity pane must resume the FLOW — resuming
  // only the bare agent would leave the FlowRun stranded `waiting` forever.
  // The most recent step row wins (a resume creates a NEW row for the re-run
  // node with the same agentExecutionId). Org-scoped through the run, and
  // visibility-scoped through the FLOW: a private flow's run may only be
  // resumed by its owner even when the agent step is org-visible in the pane
  // — otherwise any org member could drive the whole private flow. A
  // non-matching lookup falls through to the bare agent resume, which is the
  // pre-existing access this caller already had.
  const flowStep = await prisma.flowRunStep.findFirst({
    where: {
      agentExecutionId: execution.id,
      run: { organizationId: auth.organizationId, flow: agentVisibilityScope(auth.dbUser.id) },
    },
    orderBy: { startedAt: 'desc' },
    include: { run: { select: { id: true, flowId: true, status: true, userId: true, trigger: true } } },
  })
  let target: ReplyTarget = 'agent'
  if (flowStep) {
    const steps = await prisma.flowRunStep.findMany({
      where: { flowRunId: flowStep.flowRunId },
      orderBy: { order: 'asc' },
      select: { nodeId: true, status: true, output: true },
    })
    // Match THIS step's own pause, not just the run's latest one: a loop that
    // paused several iterations at once has several live pauses, and this reply
    // belongs to the iteration whose execution it was written against.
    const pending = deriveRunWaitingAll(flowStep.run.status, steps)
    const own = pending.find((entry) => entry.nodeId === flowStep.nodeId) ?? null
    target = resolveReplyTarget(flowStep.run, flowStep, own)
    // The reply endpoint never decides approvals — those resume only through
    // the approvals route with an explicit approve/reject decision.
    if (target === 'approval-block') {
      throw new ApiError('This step is waiting for an approval decision.', 400, 'FLOW_RUN_AWAITING_APPROVAL')
    }
    // target 'agent' includes the swept-run case: an ABANDONED (timed-out)
    // execution may later go waiting_for_input inside a run that already
    // `failed` — falling through to the bare agent resume still lets the
    // zombie finish and write memory, harmlessly.
  }

  // Checked AFTER the flow routing so a concurrent resume that already
  // claimed the execution (execute-agent's atomic waiting_* -> running
  // claim) makes this reply lose cleanly here instead of failing the run.
  if (execution.status !== 'waiting_for_input' || !execution.agentTaskId) {
    throw new ApiError('Execution is not waiting for input', 409, 'NOT_WAITING')
  }

  await prisma.executionMessage.create({
    data: { executionId: execution.id, role: 'user', content: message },
  })

  if (target === 'flow' && flowStep) {
    const run = flowStep.run
    // Non-manual runs executed the published graph; resume against the same
    // (mirrors the approvals route's derivation). Resume DETACHED (queued in
    // prod) rather than running the whole remaining flow inline in this HTTP
    // request — a long resume would otherwise block the caller and be killed by
    // Vercel at maxDuration, orphaning the run.
    const triggerType = (run.trigger as { type?: string } | null)?.type
    try {
      await dispatchDetachedFlowExecution({
        flowId: run.flowId,
        organizationId: auth.organizationId,
        userId: run.userId ?? auth.dbUser.id,
        flowRunId: run.id,
        reply: message,
        // The reply answers THIS step row — pass its key so a run with several
        // paused iterations resolves the right one.
        replyStepKey: flowStep.nodeId,
        usePublished: Boolean(triggerType && triggerType !== 'manual'),
      })
      return { success: true, executionId: execution.id, flowRunId: run.id, status: 'resuming' }
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError('Flow resume failed', 500, 'RUN_FAILED')
    }
  }

  if (inlineExecution) {
    try {
      const result = await runAgentExecution({
        executionId: execution.id,
        agentId: execution.agentTaskId,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        resume: true,
        reply: message,
      })
      return { success: true, executionId: execution.id, result }
    } catch (error) {
      await prisma.agentExecution.update({
        where: { id: execution.id, organizationId: auth.organizationId },
        data: {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          completedAt: new Date(),
        },
      })
      throw new ApiError('Agent resume failed', 500, 'RUN_FAILED')
    }
  } else {
    if (!workersEnabled) throw new ApiError('Agent worker is disabled', 503, 'WORKER_DISABLED')
    try {
      const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
      await queue.add('resume-agent', injectTraceContext({
        executionId: execution.id,
        agentId: execution.agentTaskId,
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
        resume: true,
        reply: message,
      }), { jobId: `${execution.id}-resume-${Date.now()}` })
    } catch {
      throw new ApiError('Unable to queue agent resume', 503, 'QUEUE_UNAVAILABLE')
    }
    return { success: true, executionId: execution.id, status: 'resuming' }
  }
}, { permission: 'agent.run' })
