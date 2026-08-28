import { Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { notify } from '@/lib/notifications/service'
import { flowSignalOutboxEvent } from '@/lib/outbox'
import { trackDetached } from '@/lib/flows/keep-alive'
import { broadcastFlowRunTick } from '@/lib/flows/run-stream'
import { truncateWithMarker } from '@/lib/flows/truncate'
import { parseFlowSettings } from '@/lib/flows/settings'
import { flowGraphSchema } from '@/lib/flows/graph'
import { jsonValue } from './run-step-persistence'
import type { FlowExecutionJob } from './execute-flow'
import type { interpretFlow } from './interpret'

type FlowGraph = ReturnType<typeof flowGraphSchema.parse>
type FlowSettings = ReturnType<typeof parseFlowSettings>
type InterpreterResult = Awaited<ReturnType<typeof interpretFlow>>

/**
 * Signal chain depth, carried on the trigger so a signal a flow emits cannot
 * recurse without bound. Duplicated from execute-flow.ts rather than exported
 * from it: importing it back would put a static cycle between the engine and
 * the phase it hands off to, for a one-line accessor.
 */
function signalDepthOfTrigger(trigger: FlowExecutionJob['trigger']): number {
  return typeof trigger?.depth === 'number' ? trigger.depth : 0
}

/**
 * The subflow / error-workflow dispatch reaches back into the engine. Dynamic,
 * for the same reason ./run-action-step does it: a static cycle would leave
 * whichever module loaded second holding undefined bindings.
 */
async function flowEngine() {
  return import('./execute-flow')
}

type FlowRow = NonNullable<Awaited<ReturnType<typeof prisma.flow.findFirst>>>
type FlowRunRow = NonNullable<Awaited<ReturnType<typeof prisma.flowRun.findFirst>>>

/**
 * Everything after the interpreter returns: drain the detached step writes,
 * classify the outcome, persist the run row, broadcast the final tick, and fire
 * the waiting/failure notifications.
 *
 * Carved out of `runFlowExecutionInner`. It is the one phase with no bearing on
 * how the run EXECUTED — it only records what happened — so it reads as a unit
 * and was worth naming: inline, the boundary between "the flow is running" and
 * "the flow has finished and we are writing it down" was invisible.
 */
export interface FinalizeFlowRunContext {
  job: FlowExecutionJob
  flow: FlowRow
  run: FlowRunRow
  graph: FlowGraph
  flowSettings: FlowSettings
  /** The interpreter's outcome. */
  result: InterpreterResult
  /**
   * Detached step-row writes started during the walk. Drained here, once,
   * before anything reads the rows back — a step row still in flight would
   * otherwise be missing from the sweep and from the run panel's final read.
   */
  pending: Promise<unknown>[]
}

export async function finalizeFlowRun(
  ctx: FinalizeFlowRunContext,
): Promise<{ status: string; output: unknown }> {
  const { job, flow, run, graph, flowSettings, result, pending } = ctx
  await Promise.all(pending) // ensure all container-step rows are written
  const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'waiting' ? 'waiting' : 'failed'
  // Output node parity: when a flow declared named outputs, callers receive the
  // named object; otherwise the implicit last-step output stands (back-compat —
  // a flow with no output node behaves EXACTLY as before). This effective output
  // is what persists on the run, chains via flow.completed, and returns to the
  // webhook caller. Only a NON-EMPTY named map overrides: an empty {} (a
  // degenerate output node with no rows — validate.ts blocks it) must never
  // clobber the real last-step output.
  const hasNamedOutputs = result.namedOutputs !== undefined && Object.keys(result.namedOutputs).length > 0
  const effectiveOutput = hasNamedOutputs ? result.namedOutputs : result.output
  // A failed run persists WHY it failed (e.g. the step-timeout message) — the
  // runs API surfaces FlowRun.error, so it must never stay null on failure.
  const runError = status === 'failed' ? truncateWithMarker(result.error ?? 'The flow failed.', 300) : null
  // A `wait` step that paused on a timer records when the run should resume, so
  // the cron scan can wake it. Any other waiting state (human reply, approval,
  // open-ended webhook callback) and every terminal state clear resumeAt.
  const resumeAt = status === 'waiting' && result.waiting?.resumeAt ? new Date(result.waiting.resumeAt) : null
  const manualRun = String(job.trigger?.type ?? 'manual') === 'manual'
  const retainTerminalData = status === 'waiting' || (
    (!manualRun || flowSettings.saveManualRuns) &&
    (status === 'succeeded' ? flowSettings.saveSuccessfulRuns : flowSettings.saveFailedRuns)
  )
  await tenantTransaction(job.organizationId, async (tx) => {
    // "Degraded" = succeeded but with fine print: a step that carried engine
    // warnings, or one that failed while the run continued (on-error
    // continue). Computed once here from the FULL persisted step set — never
    // the possibly-truncated summary the runs API returns — so the UI no
    // longer has to re-infer it per client over a partial view.
    const degraded = status === 'succeeded' && (
      await tx.flowRunStep.findMany({ where: { flowRunId: run.id }, select: { status: true, warnings: true } })
    ).some((step) => step.status === 'failed' || (Array.isArray(step.warnings) && step.warnings.length > 0))
    await tx.flowRun.update({
      where: { id: run.id, organizationId: job.organizationId },
      data: { status, output: jsonValue(effectiveOutput), error: runError, finishedAt: status === 'waiting' ? null : new Date(), resumeAt, degraded },
    })
    // Commit the terminal state and its downstream signal atomically. The
    // outbox worker handles delivery/retry after commit, so a process crash can
    // no longer leave a completed run without its chained flows.
    if (job.usePublished && (status === 'succeeded' || status === 'failed')) {
      const succeeded = status === 'succeeded'
      await tx.outboxEvent.create({
        data: flowSignalOutboxEvent({
          organizationId: job.organizationId,
          aggregateId: run.id,
          dedupeKey: `flow:${run.id}:${status}`,
          signal: {
            signal: succeeded ? 'flow.completed' : 'flow.failed',
            payload: succeeded
              ? { flowId: flow.id, flowName: flow.name, output: effectiveOutput }
              : { flowId: flow.id, flowName: flow.name, error: runError, runId: run.id },
            sourceFlowId: flow.id,
            depth: signalDepthOfTrigger(job.trigger) + 1,
          },
        }),
      })
    }
    // Keep the run's status/timing/audit identity even when data retention is
    // disabled, but remove payloads and step-level progress after dispatching
    // the outbox event. Waiting runs always retain state because resume needs it.
    if (!retainTerminalData) {
      await tx.flowRunStep.deleteMany({ where: { flowRunId: run.id } })
      await tx.flowRun.update({
        where: { id: run.id, organizationId: job.organizationId },
        data: { input: jsonValue({}), output: Prisma.DbNull },
      })
    } else if (status !== 'waiting' && !flowSettings.saveExecutionProgress) {
      await tx.flowRunStep.deleteMany({ where: { flowRunId: run.id } })
    }
  })
  // Final realtime nudge on the terminal/waiting status, so the builder settles
  // immediately instead of on the next poll.
  trackDetached(broadcastFlowRunTick(run.id, { status }))
  // A humanReview ("Request information") pause has no adapter: its waiting
  // FlowRunStep row was persisted by the interpreter's onStep path (the
  // outcome carries `{ waiting: { kind: 'input', question } }`), so the only
  // side effect owed here is telling the assignee — or the run owner when no
  // assignee is set — that the flow is waiting on them. Mirrors the
  // flow.needs_approval notify above; notify never throws into the run.
  if (status === 'waiting' && result.waiting) {
    // The waiting node id may carry a loop iteration suffix (`${id}#${index}`);
    // strip it to resolve the graph node.
    const waitingBaseId = result.waiting.nodeId.split('#')[0]
    const waitingNode = graph.nodes.find((node) => node.id === waitingBaseId)
    if (waitingNode?.type === 'humanReview') {
      await notify({
        organizationId: job.organizationId,
        userId: waitingNode.data.assigneeUserId?.trim() || run.userId || job.userId,
        type: 'flow.needs_input',
        level: 'action',
        title: `Flow "${flow.name}" needs information`,
        body: result.waiting.question ? `${result.waiting.question} (run ${run.id})` : `Reply to continue the flow (run ${run.id})`,
        executionId: flow.id,
        link: `/flows/${flow.id}/activity`,
      })
    }
  }
  if (status === 'failed') {
    // Sweep phantom 'running' rows: a timed-out agent step's adapter promise
    // was abandoned by the interpreter, so its FlowRunStep would stay stuck
    // 'running' forever. Close every such row for THIS run. The sweep wins
    // over the abandoned adapter: its terminal writes are conditional on the
    // row still being 'running' (finishStep/finish above), so a zombie
    // completion can never flip a swept step back inside a failed run.
    // Best-effort — sweep failure must not mask the run's real outcome.
    await prisma.flowRunStep
      .updateMany({
        where: { flowRunId: run.id, status: 'running' },
        data: {
          status: 'failed',
          error: runError ?? 'The flow stopped before this step finished.',
          finishedAt: new Date(),
        },
      })
      .catch(() => undefined)
  }

  if (
    status === 'failed' &&
    flowSettings.errorWorkflowId &&
    flowSettings.errorWorkflowId !== flow.id &&
    (job.errorWorkflowDepth ?? 0) < 1
  ) {
    await (await flowEngine()).dispatchDetachedFlowExecution({
      flowId: flowSettings.errorWorkflowId,
      organizationId: job.organizationId,
      userId: job.userId,
      usePublished: true,
      errorWorkflowDepth: (job.errorWorkflowDepth ?? 0) + 1,
      trigger: { type: 'error', sourceFlowId: flow.id, sourceRunId: run.id },
      input: { flowId: flow.id, flowName: flow.name, runId: run.id, error: runError },
    }).catch((error) => {
      apiLogger.error('flow error-workflow dispatch failed', {
        flowId: flow.id,
        errorWorkflowId: flowSettings.errorWorkflowId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  return { status, output: effectiveOutput }
}
