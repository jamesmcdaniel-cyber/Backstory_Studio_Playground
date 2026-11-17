/**
 * What a flow run owes the rest of the system once it has stopped — for the
 * paths that stop it OUTSIDE the engine's own finalize.
 *
 * finalizeFlowRun (src/features/flows/finalize-flow-run.ts) is the normal
 * place a run ends, and it does more than flip a status: it supersedes the
 * run's open approvals, emits the `flow.failed` signal, dispatches the flow's
 * error workflow, hands an ROI data flow's outcome back to the ROI service,
 * and nudges the live UI. The reaper, the dead-letter terminalizer, the
 * waiting-run cancel and the resume preamble all terminalize a run with a bare
 * status write instead, so every one of those effects silently never
 * happened: an approval that stayed approvable for a dead run, a chained flow
 * that never heard its upstream failed, an error workflow that never ran.
 *
 * `onFlowRunTerminalized` is that missing half, called once per run that a
 * caller actually moved (its own guarded write matched the row). It is:
 *
 *  - best-effort: every effect is fenced on its own, and nothing here throws
 *    into the caller — the run already ended, and how it ended stands;
 *  - idempotent: it re-reads the run and acts only when the row still says
 *    the status it was called for, the outbox write is deduplicated by key,
 *    and superseding approvals or waking a parent twice is a no-op;
 *  - bounded: batch callers go through onFlowRunsTerminalized, which caps how
 *    many runs one sweep follows up on.
 */

import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { ambientOrganization } from '@/lib/tenant-database-context'
import { broadcastFlowRunTick } from '@/lib/flows/run-stream'
import { trackDetached } from '@/lib/flows/keep-alive'
import { flowSignalOutboxEvent } from '@/lib/outbox'
import { parseFlowSettings } from '@/lib/flows/settings'
import { describeSubflowWait } from '@/lib/flows/subflow'

/** Most runs one sweep follows up on; the rest still end, just without the follow-up. */
export const TERMINAL_EFFECTS_BATCH_LIMIT = 100

type TerminalStatus = 'failed' | 'cancelled'

type RunTrigger = { type?: unknown; parentRunId?: unknown; depth?: unknown } | null

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function fenced(label: string, flowRunId: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch (error) {
    apiLogger.error(`flow terminal effect failed: ${label}`, { flowRunId, error: errorMessage(error) })
  }
}

/**
 * A CHILD flow run settled (or paused somewhere new) without its parent being
 * the one that drove it — an approval decision, a timer, a webhook, an
 * external agent or a cancel reached the child directly. The parent paused on
 * this child (`waiting.childRunId`) has nothing else that would ever wake it,
 * and its reply box would forward into a child that is no longer listening.
 *
 *  - child finished (any terminal status): resume the parent at that step; the
 *    subflow step reads the child's outcome (run-action-step.ts).
 *  - child paused again: refresh the parent's waiting row with the child's
 *    current wait, so its banner offers a reply box only for a question.
 *
 * A parent that is not `waiting` on THIS child is left alone: when the parent
 * drives the child inline (a fresh subflow step, or a reply forwarded into
 * it), the parent is `running` and consumes the outcome itself.
 */
export async function wakeSubflowParent(params: {
  organizationId: string
  childRunId: string
  childTrigger: unknown
  childStatus: string
  childName?: string
}): Promise<void> {
  const trigger = params.childTrigger as RunTrigger
  if (trigger?.type !== 'subflow' || typeof trigger.parentRunId !== 'string' || !trigger.parentRunId) return
  const parent = await prisma.flowRun.findFirst({
    where: { id: trigger.parentRunId, organizationId: params.organizationId, status: 'waiting' },
    select: { id: true, flowId: true, userId: true, trigger: true, flow: { select: { userId: true } } },
  })
  if (!parent) return
  const steps = await prisma.flowRunStep.findMany({
    where: { flowRunId: parent.id, status: 'waiting' },
    orderBy: { order: 'desc' },
    select: { id: true, nodeId: true, output: true },
  })
  const step = steps.find((row) => (row.output as { waiting?: { childRunId?: unknown } } | null)?.waiting?.childRunId === params.childRunId)
  if (!step) return

  if (params.childStatus === 'waiting') {
    const childStep = await prisma.flowRunStep.findFirst({
      where: { flowRunId: params.childRunId, status: 'waiting' },
      orderBy: { order: 'desc' },
      select: { output: true },
    })
    const previous = (step.output as { waiting?: Record<string, unknown> } | null)?.waiting ?? {}
    const wait = describeSubflowWait(childStep?.output, params.childName ?? 'The subflow')
    await prisma.flowRunStep.updateMany({
      where: { id: step.id, status: 'waiting' },
      data: { output: JSON.parse(JSON.stringify({ waiting: { ...wait, childRunId: params.childRunId, childFlowId: previous.childFlowId } })) },
    })
    trackDetached(broadcastFlowRunTick(parent.id, { status: 'waiting' }))
    return
  }

  const userId = parent.userId ?? parent.flow?.userId
  if (!userId) return
  const triggerType = (parent.trigger as { type?: string } | null)?.type
  const { dispatchDetachedFlowExecution } = await import('@/features/flows/execute-flow')
  await dispatchDetachedFlowExecution({
    flowId: parent.flowId,
    organizationId: params.organizationId,
    userId,
    flowRunId: parent.id,
    reply: '',
    replyStepKey: step.nodeId,
    usePublished: Boolean(triggerType && triggerType !== 'manual'),
    subflowWake: { childRunId: params.childRunId },
  })
}

/**
 * Follow up on ONE run a caller just terminalized out of band. See the file
 * header for what it owes and why each piece is safe to repeat.
 */
export async function onFlowRunTerminalized(params: { flowRunId: string; status: TerminalStatus }): Promise<void> {
  const { flowRunId, status } = params
  // systemPrisma: id-keyed read of a run a caller just terminalized itself;
  // reapers and dead-letter terminalizers hold no tenant context. Every write
  // below is scoped to the organization read here.
  const run = await systemPrisma.flowRun
    .findUnique({
      where: { id: flowRunId },
      select: {
        id: true,
        flowId: true,
        organizationId: true,
        userId: true,
        status: true,
        error: true,
        trigger: true,
        flow: { select: { id: true, name: true, settings: true, userId: true } },
      },
    })
    .catch(() => null)
  // Idempotency: act only on a row that still says what the caller wrote. A
  // run a late finish already overwrote has had its own finalize.
  if (!run || run.status !== status) return
  const organizationId = run.organizationId
  const trigger = run.trigger as RunTrigger
  const triggerType = typeof trigger?.type === 'string' ? trigger.type : 'manual'
  const error = run.error ?? (status === 'cancelled' ? 'The run was cancelled.' : 'The flow failed.')

  await ambientOrganization.run(organizationId, async () => {
    // An approval left pending on a dead run would still execute its write.
    await fenced('approvals', flowRunId, async () => {
      const { settleRunApprovals } = await import('@/features/flows/approval-settle')
      await settleRunApprovals({ organizationId, runId: flowRunId, status })
    })
    trackDetached(broadcastFlowRunTick(flowRunId, { status }))

    if (status === 'failed') {
      // Chained flows listen for this. Same event, same dedupe key as
      // finalizeFlowRun, so a run that somehow reaches both emits once.
      if (triggerType !== 'manual') {
        await fenced('flow.failed signal', flowRunId, async () => {
          await prisma.outboxEvent.create({
            data: flowSignalOutboxEvent({
              organizationId,
              aggregateId: flowRunId,
              dedupeKey: `flow:${flowRunId}:failed`,
              signal: {
                signal: 'flow.failed',
                payload: { flowId: run.flowId, flowName: run.flow?.name ?? '', error, runId: flowRunId },
                sourceFlowId: run.flowId,
                depth: (typeof trigger?.depth === 'number' ? trigger.depth : 0) + 1,
              },
            }),
          }).catch((err: unknown) => {
            // P2002 on (organizationId, dedupeKey): already emitted.
            if ((err as { code?: string } | null)?.code !== 'P2002') throw err
          })
        })
      }

      // The flow's error workflow. An error-triggered run never dispatches
      // another one — the same one-hop cap finalizeFlowRun keeps with
      // errorWorkflowDepth, which a terminalized run no longer carries.
      const errorWorkflowId = parseFlowSettings(run.flow?.settings).errorWorkflowId
      const userId = run.userId ?? run.flow?.userId
      if (errorWorkflowId && errorWorkflowId !== run.flowId && triggerType !== 'error' && userId) {
        await fenced('error workflow', flowRunId, async () => {
          const { dispatchDetachedFlowExecution } = await import('@/features/flows/execute-flow')
          await dispatchDetachedFlowExecution({
            flowId: errorWorkflowId,
            organizationId,
            userId,
            usePublished: true,
            errorWorkflowDepth: 1,
            trigger: { type: 'error', sourceFlowId: run.flowId, sourceRunId: flowRunId },
            input: { flowId: run.flowId, flowName: run.flow?.name ?? '', runId: flowRunId, error },
          })
        })
      }

      // An ROI page's data flow: hand the failure back so the page stops
      // waiting on a load that is not coming.
      await fenced('roi continuation', flowRunId, async () => {
        const { roiAnalysisIdOfTrigger } = await import('@/lib/roi/data-source')
        const analysisId = roiAnalysisIdOfTrigger(run.trigger)
        if (!analysisId) return
        const { continueRoiAnalysisAfterDataFlow } = await import('@/lib/roi/service')
        await continueRoiAnalysisAfterDataFlow(organizationId, analysisId, { status, error })
      })
    }

    // A parent flow paused on this run as its subflow learns it ended.
    await fenced('subflow parent', flowRunId, () =>
      wakeSubflowParent({ organizationId, childRunId: flowRunId, childTrigger: run.trigger, childStatus: status, childName: run.flow?.name }),
    )
  })
}

/** onFlowRunTerminalized for a sweep's worth of runs: sequential, capped, never throws. */
export async function onFlowRunsTerminalized(flowRunIds: string[], status: TerminalStatus): Promise<void> {
  for (const flowRunId of flowRunIds.slice(0, TERMINAL_EFFECTS_BATCH_LIMIT)) {
    await onFlowRunTerminalized({ flowRunId, status }).catch((error) => {
      apiLogger.error('flow terminal effects failed', { flowRunId, error: errorMessage(error) })
    })
  }
}
