import { randomBytes } from 'node:crypto'
import type { Job } from 'bullmq'
import { ambientOrganization } from '@/lib/tenant-database-context'
import { prisma } from '@/lib/prisma'
import { hashToken } from '@/lib/crypto/secrets'
import { applyAlwaysOutputData, keepDetachedWorkAlive } from '@/lib/flows/keep-alive'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { assertQueueConsumerAlive } from '@/lib/queue/heartbeat'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { flowJobOptions } from '@/lib/flows/queue-options'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validationErrorMessage } from '@/lib/flows/validate'
import { validateGraphForRun } from '@/lib/flows/run-validation'
import { isDeterministicUserFailure } from '@/lib/queue/flow-dead-letter'
import { createRunActionStep } from './run-action-step'
import { createOnStep } from './run-step-recorder'
import { finalizeFlowRun } from './finalize-flow-run'
import { seedRunState } from './seed-run-state'
import { apiLogger } from '@/lib/logger'
import { ApiError } from '@/lib/server/api-handler'
import { triggerFromGraph, triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { applyInputDefaults, missingRequiredInputFields } from '@/lib/flows/input-validation'
import { shouldReuseInput, storedRunInput } from '@/lib/flows/reuse-input'
import { stepLabelsOf } from '@/lib/flows/token-text'
import { interpretFlow, FlowCancelledError, type RunAgentFn, type RunActionFn } from './interpret'
import { jsonValue, retryWarnings } from './run-step-persistence'
// Re-exported: retryWarnings moved to ./run-step-persistence when the
// action-step executor was carved out, and its test imports it from here.
export { retryWarnings }
import { truncateWithMarker } from '@/lib/flows/truncate'
import { DEFAULT_AGENT_MODEL, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { buildFlowExecutionManifest, executionManifestMatches, type FlowExecutionManifest } from '@/lib/flows/execution-manifest'
import { runScopeKey } from '@/lib/flows/side-effect-ledger'
import { parseFlowSettings } from '@/lib/flows/settings'
import { injectTraceContext, withExtractedTraceContext, withSpan } from '@/lib/observability/otel'

export type FlowExecutionJob = {
  flowId: string
  organizationId: string
  userId: string
  /** W3C context injected at enqueue; never user-controlled request headers. */
  traceContext?: Record<string, string>
  input?: unknown
  flowRunId?: string
  // Resume a paused run: the user's reply to the ask-user step that paused it.
  reply?: string
  /**
   * WHICH pause the reply answers — the waiting step's id, iteration suffix
   * included (`${nodeId}#${index}`). Optional: a run blocked on a single pause
   * resolves it without a key. Required (enforced at resume) when a loop or
   * parallel left several reviews waiting at once, so one reply cannot be
   * misrouted to whichever iteration happened to be recorded last.
   */
  replyStepKey?: string
  // Scheduled/triggered runs execute the PUBLISHED graph; a manual builder run
  // executes the working draft so you can test before publishing.
  usePublished?: boolean
  // How this run was started — persisted on the FlowRun for provenance.
  trigger?: { type: 'manual' | 'schedule' | 'webhook' | 'form' | 'signal' | 'subflow' | 'poll' | 'activity' | 'slack' | 'error'; [key: string]: unknown }
  /**
   * The scheduled occurrence this run belongs to (see dueOccurrence). Set ONLY
   * by scheduled dispatch; everything else leaves it undefined and is exempt
   * from the (flowId, scheduledFor) unique index. Two ticks racing on one
   * occurrence therefore produce one run, and the loser gets P2002.
   */
  scheduledFor?: Date | null
  // How many subflow hops deep this run already is (0/omitted = top-level).
  // Each subflow step dispatch passes depth + 1; the guard caps nesting.
  subflowDepth?: number
  /** Prevents error-workflow chains from recursively dispatching forever. */
  errorWorkflowDepth?: number
  // Re-run from a step: replay `runId`'s recorded outputs for every step that
  // ran BEFORE `nodeId` (on that run's pinned graph), then execute from
  // `nodeId` onward as a NEW run. Route-failed steps re-take their error edge.
  replayFrom?: { runId: string; nodeId: string }
  /**
   * "Pretend this step produced X." Keyed by node id, or by the `node#i`
   * iteration key inside a loop. Applied after replay seeding AND after
   * pinData, so an override is the most specific intent and wins. Persisted on
   * the run for provenance.
   */
  overrides?: Record<string, unknown>
  /**
   * Patch-and-resume: reopen an existing FAILED run and re-execute from
   * `nodeId` on the SAME run row. Unlike replayFrom (which forks to a new run)
   * this keeps the run id — and therefore its idempotency keys, so replayed
   * steps do not re-fire external writes.
   */
  resumeFrom?: { nodeId: string }
  // Partial execution for the node editor step controls. stopAfterNodeId runs
  // through that node and stops ("Execute step"); stopBeforeNodeId runs
  // everything feeding a node but not the node ("Execute previous nodes").
  stopAfterNodeId?: string
  stopBeforeNodeId?: string
  // Set by startFlowExecution: the FlowRun row was already created (validated
  // input + pinned graph persisted on it) before dispatch, so execution must
  // adopt that row instead of creating a new one. This is what lets the
  // interactive execute route return a run id immediately while the run
  // continues in the background.
  preparedRunId?: string
  /** Stable source delivery key (currently outbox signals) for queue dedupe. */
  deliveryId?: string
}


type FlowRow = NonNullable<Awaited<ReturnType<typeof prisma.flow.findFirst>>>
type FlowRunRow = NonNullable<Awaited<ReturnType<typeof prisma.flowRun.findFirst>>>
type FlowGraph = ReturnType<typeof flowGraphSchema.parse>

/** Load + guard the source run for a re-run-from-step request. */
async function loadReplaySource(job: FlowExecutionJob): Promise<FlowRunRow | null> {
  if (!job.replayFrom) return null
  const replaySource = await prisma.flowRun.findFirst({
    where: { id: job.replayFrom.runId, flowId: job.flowId, organizationId: job.organizationId },
  })
  if (!replaySource) throw new ApiError('The run to replay from no longer exists.', 404, 'NOT_FOUND')
  if (replaySource.status === 'running' || replaySource.status === 'waiting') {
    throw new ApiError('That run is still in progress — wait for it to finish before re-running from a step.', 409, 'FLOW_REPLAY_ACTIVE')
  }
  return replaySource
}

/**
 * Pin + parse the graph this run executes, then validate it against current
 * org state (agents/connections it references must still exist).
 *
 * Snapshot pinning: a resumed/prepared run executes the EXACT graph it started
 * with (graphSnapshot), never whatever the flow currently is — a publish made
 * while the run waited must not reshape a run already in flight. A replay pins
 * the source run's snapshot the same way. Legacy fallback: a pre-snapshot run
 * (graphSnapshot null) uses the flow's current graph — the same source a fresh
 * run would use.
 */
async function resolveValidatedGraph(
  job: FlowExecutionJob,
  flow: FlowRow,
  existingRun: FlowRunRow | null,
  replaySource: FlowRunRow | null,
): Promise<{ graph: FlowGraph; agents: { id: string; title: string }[]; manifest: FlowExecutionManifest }> {
  const currentGraph = job.usePublished && flow.publishedGraph != null ? flow.publishedGraph : flow.graph
  const source = existingRun
    ? existingRun.graphSnapshot ?? currentGraph
    : replaySource
      ? replaySource.graphSnapshot ?? currentGraph
      : currentGraph
  const graph = flowGraphSchema.parse(source)
  // Same load-and-validate the publish route and the resume endpoint use, so
  // "this graph is runnable" cannot mean three different things in three
  // places (src/lib/flows/run-validation.ts).
  const { validation, context } = await validateGraphForRun(graph, {
    organizationId: job.organizationId,
    userId: job.userId,
    flowId: job.flowId,
  })
  if (!validation.ok) {
    throw new ApiError(validationErrorMessage(validation), 400, 'FLOW_VALIDATION_ERROR')
  }
  const agents = context.agents
  const agentRefs = context.agentRefs
  const toolCatalog = context.toolCatalog
  const manifest = buildFlowExecutionManifest({
    graph,
    agents,
    toolCatalog,
    agentModel: DEFAULT_AGENT_MODEL,
    summaryModel: DEFAULT_SUMMARY_MODEL,
  })
  return { graph, agents: agentRefs, manifest }
}

/**
 * Fresh-run input resolution. Required trigger inputs (declared on the trigger
 * node) must be present. Input memory: before failing on missing fields, fall
 * back to the last successful run's input — but only when the flow hasn't been
 * edited since that run started (shouldReuseInput), so an edited flow always
 * demands fresh input. A run that supplies every required field never falls
 * back: deliberately different-but-complete input always wins.
 */
async function resolveFreshRunInput(
  job: FlowExecutionJob,
  flow: FlowRow,
  graph: FlowGraph,
  initial: unknown,
): Promise<{ input: unknown; reusedInput: boolean }> {
  const inputFields = triggerInputFieldsFromTrigger(triggerFromGraph(graph, flow.trigger))
  // Fill declared per-field defaults into absent/blank structured inputs
  // BEFORE the required-check, so a required field WITH a default is
  // satisfied. Precedence: explicit provided value > field default >
  // last-successful-reuse fallback (a field with neither an explicit value
  // nor a default stays missing and can still trigger the reuse fallback).
  let input = applyInputDefaults(inputFields, initial)
  let reusedInput = false
  let missing = missingRequiredInputFields(inputFields, input)
  if (missing.length) {
    const lastSuccess = await prisma.flowRun.findFirst({
      where: { flowId: flow.id, organizationId: job.organizationId, status: 'succeeded' },
      orderBy: { startedAt: 'desc' },
      select: { input: true, startedAt: true },
    })
    if (lastSuccess && shouldReuseInput({ flowUpdatedAt: flow.updatedAt, lastSuccessStartedAt: lastSuccess.startedAt })) {
      const candidate = storedRunInput(lastSuccess.input)
      if (!missingRequiredInputFields(inputFields, candidate).length) {
        input = candidate
        reusedInput = true
        missing = []
      }
    }
  }
  if (missing.length) {
    throw new ApiError(
      `Missing required input field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      400,
      'FLOW_INPUT_ERROR',
    )
  }
  return { input, reusedInput }
}

/** Create the FlowRun row a fresh execution runs against. */
async function createFlowRunRow(
  job: FlowExecutionJob,
  flow: FlowRow,
  graph: FlowGraph,
  input: unknown,
  reusedInput: boolean,
  manifest: FlowExecutionManifest,
): Promise<FlowRunRow> {
  return prisma.flowRun.create({
    data: {
      flowId: flow.id,
      status: 'running',
      input: jsonValue({ prompt: input }),
      // reusedInput marks the run as replaying the last successful input —
      // the run panel surfaces it so replayed payloads are never silent.
      trigger: jsonValue({ ...(job.trigger ?? { type: 'manual' }), ...(reusedInput ? { reusedInput: true } : {}), ...(job.replayFrom ? { replayOf: job.replayFrom.runId, fromNodeId: job.replayFrom.nodeId } : {}) }),
      graphSnapshot: jsonValue(graph),
      executionManifest: jsonValue(manifest),
      // A fork carries its overrides on the NEW run, never on the flow draft.
      ...(job.overrides && Object.keys(job.overrides).length
        ? { stateOverrides: jsonValue(job.overrides) }
        : {}),
      // Null for everything except scheduled dispatch, which is what keeps the
      // unique index bound to scheduled runs only.
      ...(job.scheduledFor ? { scheduledFor: job.scheduledFor } : {}),
      organizationId: job.organizationId,
      userId: job.userId,
    },
  })
}

/**
 * Terminalize a pre-created run whose execution could not start or crashed
 * outside the interpreter's own failure paths. Status-guarded: a run that
 * legitimately settled or paused (`waiting`) is never clobbered.
 */
export async function failPreparedRun(flowRunId: string, organizationId: string, message: string): Promise<void> {
  const errorMessage = truncateWithMarker(message, 300)
  // The flip and the step sweep run inside one interactive transaction — the
  // same per-pair atomicity shape as the reaper (see src/lib/flows/reap.ts):
  // a crash between the two statements must never land a `failed` run with a
  // step still `running` forever, since the status guard above means nothing
  // ever revisits a `failed` run to clean up steps it left behind. The whole
  // transaction stays best-effort (caller treats this as fire-and-forget),
  // so a failure here is swallowed exactly as the two independent calls used
  // to be.
  await prisma
    .$transaction(async (tx) => {
      const terminalized = await tx.flowRun.updateMany({
        where: { id: flowRunId, organizationId, status: 'running' },
        data: { status: 'failed', error: errorMessage, finishedAt: new Date() },
      })
      // Sweep phantom 'running' step rows — but only when THIS call actually
      // failed the run: a run left untouched (already settled, or legitimately
      // `waiting`) may have a step genuinely still in flight, which must not be
      // clobbered. Mirrors the interpreter's own end-of-run sweep so a run
      // failed here never leaves an orphaned step.
      if (terminalized.count) {
        await tx.flowRunStep.updateMany({
          where: { flowRunId, status: 'running' },
          data: { status: 'failed', error: errorMessage, finishedAt: new Date() },
        })
      }
    })
    .catch(() => undefined)
}

/**
 * Best-effort link from a running FlowRunStep row to the AgentExecution it
 * started, so the runs panel can follow the agent's live process events
 * while the step is still in flight. Status-guarded like every other write
 * to this row: once a sweep has already closed the row out (timeout,
 * dead-letter, cancel, failPreparedRun), a late-arriving execution id must
 * not resurrect a terminal row by writing back onto it.
 */
export async function linkExecutionToRunningStep(stepId: string, executionId: string): Promise<void> {
  await prisma.flowRunStep
    .updateMany({ where: { id: stepId, status: 'running' }, data: { agentExecutionId: executionId } })
    .catch(() => undefined)
}

/**
 * Run a flow to completion. Each agent node delegates to the real agent runtime
 * (runAgentExecution) and is recorded as a FlowRunStep so the builder canvas can
 * poll live per-step status. Returns the terminal run status + output.
 */
export async function runFlowExecution(
  job: FlowExecutionJob,
): Promise<{ flowRunId: string; status: string; output: unknown }> {
  // The engine writes FlowRunStep rows, which resolve tenancy through their
  // parent run rather than a column of their own. Establishing the job's tenant
  // here lets the Prisma guard scope those writes under RLS without threading a
  // transaction through ~20 call sites in this file.
  return withSpan(
    'flow.run',
    {
      'backstory.flow.id': job.flowId,
      'backstory.organization.id': job.organizationId,
      'backstory.flow.trigger': job.trigger?.type ?? 'manual',
      'backstory.flow.run_id': job.preparedRunId ?? job.flowRunId,
    },
    () => ambientOrganization.run(job.organizationId, () => runFlowExecutionInner(job)),
  )
}

async function runFlowExecutionInner(
  job: FlowExecutionJob,
): Promise<{ flowRunId: string; status: string; output: unknown }> {
  const flow = await prisma.flow.findFirst({ where: { id: job.flowId, organizationId: job.organizationId } })
  if (!flow) throw new Error('Flow not found')
  const flowSettings = parseFlowSettings(flow.settings)
  const resuming = Boolean(job.flowRunId && job.reply !== undefined)
  // Patch-and-resume: same run row, re-executed from a chosen step. Carries a
  // flowRunId but no reply, so it never collides with the resume path above.
  const patching = Boolean(job.flowRunId && job.resumeFrom && !resuming)
  const prepared = Boolean(job.preparedRunId) && !resuming && !patching
  if (!resuming && !patching && flowSettings.concurrencyLimit) {
    const alreadyRunning = await prisma.flowRun.count({
      where: {
        flowId: flow.id,
        organizationId: job.organizationId,
        status: 'running',
        ...(job.preparedRunId ? { id: { not: job.preparedRunId } } : {}),
      },
    })
    if (alreadyRunning >= flowSettings.concurrencyLimit) {
      throw new ApiError(
        `This flow already has ${alreadyRunning} running execution${alreadyRunning === 1 ? '' : 's'} (limit ${flowSettings.concurrencyLimit}).`,
        429,
        'FLOW_CONCURRENCY_LIMIT',
      )
    }
  }

  // Resume: atomically claim the run — only a genuinely `waiting` run may be
  // resumed. A concurrent resume (e.g. the reply route and the approvals
  // route racing), a run the reaper already terminalized, or a duplicate
  // reply delivery all lose cleanly here instead of re-interpreting an
  // already-moving or already-dead run. Mirrors execute-agent.ts's
  // waiting_* -> running atomic claim. Refresh startedAt so reapStuckFlowRuns
  // does not mark the run failed the moment it is legitimately resumed after
  // a long approval pause.
  let existingRun: Awaited<ReturnType<typeof prisma.flowRun.findFirst>> = null
  let replaySource: Awaited<ReturnType<typeof prisma.flowRun.findFirst>> = null
  if (resuming) {
    const claimed = await prisma.flowRun.updateMany({
      where: { id: job.flowRunId, organizationId: job.organizationId, status: 'waiting' },
      data: { status: 'running', startedAt: new Date() },
    })
    if (claimed.count === 0) throw new ApiError('This run is not waiting for input', 409, 'FLOW_RUN_NOT_WAITING')
  }
  // Patch claim: only a FAILED run may be patched and resumed. Rewriting a
  // succeeded run's history corrupts the record, and running/waiting runs are
  // already owned by the resume path above. Atomic, like the resume claim, so
  // two concurrent patch requests cannot both re-enter the same run.
  if (patching) {
    const claimed = await prisma.flowRun.updateMany({
      where: { id: job.flowRunId, organizationId: job.organizationId, status: 'failed' },
      data: { status: 'running', error: null, finishedAt: null, startedAt: new Date() },
    })
    if (claimed.count === 0) {
      throw new ApiError(
        'Only a failed run can be patched and resumed. Start a separate run instead.',
        409,
        'FLOW_PATCH_NOT_FAILED',
      )
    }
  }
  // Invariant: once the resume claim above flips a run to `running`, the
  // read-only preparation up to and including graph validation is wrapped so
  // that any throw here — a deleted agent/connection the snapshot still
  // references, a malformed snapshot, graph validation failure — rolls the run
  // back to `waiting` before rethrowing. Otherwise the run would be stuck
  // `running` with no executor, and the user's reply would be unretryable
  // until the reaper terminalizes it after 30 minutes. A PREPARED run (row
  // created up front by startFlowExecution) instead terminalizes as `failed`
  // — there is no prior state to roll back to, and leaving it `running` would
  // orphan it until the reaper. The later resume-state block (marking the
  // waiting step resumed, superseding stale approvals) sits OUTSIDE this wrap:
  // those writes are destructive, so a blind rollback could not restore them
  // anyway — a throw there strands the run until the reaper sweeps it (rare:
  // plain DB writes). Once interpretFlow begins, failures are handled by the
  // existing failure paths (run marked `failed`) — this rollback must not
  // extend into that phase.
  let graph!: FlowGraph
  let orgAgents: { id: string; title: string }[] = []
  let manifest!: FlowExecutionManifest
  try {
    if (resuming || patching) {
      existingRun = await prisma.flowRun.findFirst({ where: { id: job.flowRunId, organizationId: job.organizationId } })
      if (!existingRun) throw new Error('Flow run not found after claim')
      // Overrides supplied with a patch are persisted on the run itself, so the
      // row carries the provenance of what was faked and the interpreter below
      // reads them from one place regardless of fork-vs-patch.
      if (patching && job.overrides && Object.keys(job.overrides).length) {
        await prisma.flowRun.updateMany({
          where: { id: existingRun.id, organizationId: job.organizationId },
          data: { stateOverrides: jsonValue(job.overrides) },
        })
        existingRun = { ...existingRun, stateOverrides: jsonValue(job.overrides) as never }
      }
    }
    if (prepared) {
      existingRun = await prisma.flowRun.findFirst({ where: { id: job.preparedRunId, organizationId: job.organizationId } })
      if (!existingRun) throw new Error('Prepared flow run not found')
      // Stale/duplicate delivery (a reaped, cancelled, or already-settled
      // run): executing it again would double every side effect — report the
      // stored outcome instead.
      if (existingRun.status !== 'running') {
        return { flowRunId: existingRun.id, status: existingRun.status, output: existingRun.output }
      }
      // First pickup of this prepared row: startFlowExecution set startedAt at
      // ROW CREATION, before dispatch — in queue mode that is before the queue
      // wait, not before execution. Refresh it here, exactly as the resume/patch
      // claims above do, so the persisted duration measures execution only.
      const adoptedAt = new Date()
      await prisma.flowRun.updateMany({
        where: { id: existingRun.id, organizationId: job.organizationId, status: 'running' },
        data: { startedAt: adoptedAt },
      })
      existingRun = { ...existingRun, startedAt: adoptedAt }
    }
    if (!resuming) replaySource = await loadReplaySource(job)
    const resolvedGraph = await resolveValidatedGraph(job, flow, existingRun, replaySource)
    graph = resolvedGraph.graph
    orgAgents = resolvedGraph.agents
    manifest = resolvedGraph.manifest
    // The drift gate protects runs that already executed steps: resuming or
    // patching against changed agents/tools would silently mix two
    // configurations in one run. A PREPARED run has executed nothing — the
    // manifest it carries was pinned by the web process, and this (worker)
    // process may be a different deploy with newer in-repo tool schemas, so a
    // mismatch here is rolling-deploy skew, not danger. It executes entirely
    // with this process's consistent view; re-pin the manifest to that view so
    // any LATER resume compares like-for-like.
    if ((resuming || patching) && existingRun?.executionManifest && !executionManifestMatches(existingRun.executionManifest, manifest)) {
      throw new ApiError(
        'This run’s agent or integration configuration changed after it started. Start a new run so it can use the updated configuration safely.',
        409,
        'FLOW_DEPENDENCY_DRIFT',
      )
    }
    if (prepared && existingRun && !executionManifestMatches(existingRun.executionManifest, manifest)) {
      await prisma.flowRun.updateMany({
        where: { id: existingRun.id, organizationId: job.organizationId },
        data: { executionManifest: jsonValue(manifest) },
      })
    }
  } catch (error) {
    // The `status: 'running'` guard means we only roll back a claim we
    // ourselves hold — never stomp a reaper's terminal `failed` write.
    if (resuming) {
      // Rolling back to `waiting` says "try that reply again" — right for a
      // transient failure (a crash, a lost race), wrong for one that is
      // deterministic. A resume executes the run's PINNED snapshot, so a
      // snapshot naming an agent that has since been deleted can never
      // validate again no matter how the flow is edited afterwards: the run
      // would sit `waiting` forever, swallowing every reply in silence (the
      // user clicks send, the run flicks to running and back, nothing is
      // said). Terminalize instead — the failure becomes visible on the run,
      // with the reason on it. Same predicate as the dead-letter path, for
      // the same reason: a replay of this cannot succeed.
      const terminal = isDeterministicUserFailure(error)
      const message = error instanceof Error ? error.message : 'This run could not be resumed.'
      await prisma.flowRun.updateMany({
        where: { id: job.flowRunId, organizationId: job.organizationId, status: 'running' },
        data: terminal
          ? { status: 'failed', error: message.slice(0, 300), finishedAt: new Date() }
          : { status: 'waiting' },
      })
      if (terminal) {
        // A step left `waiting` would keep the run looking answerable in the
        // UI after the run itself has stopped. Mirrors the dead-letter sweep.
        await prisma.flowRunStep.updateMany({
          where: { flowRunId: job.flowRunId, status: { in: ['waiting', 'running'] } },
          data: { status: 'failed', error: message.slice(0, 300), finishedAt: new Date() },
        })
      }
    }
    // A patch claim that never got to execute rolls back to `failed` — the
    // state it was in — so the run stays patchable instead of being stranded
    // `running` with no executor.
    if (patching) {
      await prisma.flowRun.updateMany({
        where: { id: job.flowRunId, organizationId: job.organizationId, status: 'running' },
        data: { status: 'failed' },
      })
    }
    if (prepared && existingRun) {
      await failPreparedRun(existingRun.id, job.organizationId, error instanceof Error ? error.message : 'The flow could not start.')
    }
    throw error
  }
  let input: unknown = job.input ?? ''
  // A replay re-runs the SOURCE run's input by default — that's the run being
  // repeated. Explicit job.input still wins.
  if (replaySource && job.input === undefined) input = storedRunInput(replaySource.input)

  // Fresh runs resolve defaults/required-fields/reuse here. Skipped when
  // resuming (the original input was validated on the first run) and for
  // prepared runs (startFlowExecution already resolved + persisted the input,
  // and job.input carries the resolved value through the queue).
  let reusedInput = false
  if (!resuming && !prepared) {
    const resolved = await resolveFreshRunInput(job, flow, graph, input)
    input = resolved.input
    reusedInput = resolved.reusedInput
  }
  const run = existingRun ?? await createFlowRunRow(job, flow, graph, input, reusedInput, manifest)
  // Resume integrity: a resume request carries the user's reply, not the run
  // input, so `input` re-derives as '' here — downstream `Run input` tokens
  // would resolve empty. Reload the original input persisted on the run row.
  // Guard: an explicit non-empty input passed alongside a resume still wins
  // (an unlikely caller override — the execute route never sends one).
  if (resuming && (input == null || input === '')) {
    input = storedRunInput(run.input) ?? ''
  }

  // Everything a run starts FROM — which nodes already count as done, which of
  // their outputs replay, which paused approval or child run this resume
  // re-enters, where the step numbering continues — lives in ./seed-run-state.
  // Nothing in there executes a node; it only decides the starting position.
  const {
    nodeTypeById,
    completed,
    completedItems,
    completedRoutes,
    completedProvenance,
    resumeNodeId,
    resumeExecutionId,
    pausedApprovalByNode,
    pausedSubflowRunByNode,
    nextOrder,
    pending,
  } = await seedRunState({ job, run, graph, resuming, patching, replaySource })
  // The interpreter's per-step callback lives in ./run-step-recorder — the
  // counterpart to ./run-action-step. Between them they are the run's only
  // writers of step rows: this one for steps the INTERPRETER decides, that one
  // for steps the ENGINE executes.
  const onStep = createOnStep({ flow, run, nodeTypeById, nextOrder, pending })

  // Adapter: each agent node runs the real agent and records a FlowRunStep row.
  const runAgent: RunAgentFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: node.id,
        order: nextOrder(),
        status: 'running',
        input: { prompt: node.input },
        startedAt: new Date(),
      },
    })
    // Terminal writes below target this row ONLY while it is still 'running'.
    // A step timeout makes the interpreter abandon this promise and the
    // end-of-run sweep closes the row as failed; if the abandoned agent later
    // finishes, its late write must not resurrect the swept row inside a
    // failed run — the sweep is authoritative.
    const finishStep = async (data: Record<string, unknown>) => {
      await prisma.flowRunStep.updateMany({ where: { id: step.id, status: 'running' }, data })
    }
    // Link the agent execution to this step row the moment the execution row
    // exists (not only at the end of the run), so the runs panel can follow
    // the agent's live process events while the step is still running.
    const onExecutionCreated = (executionId: string) => {
      void linkExecutionToRunningStep(step.id, executionId)
    }
    try {
      // Resuming this node? Re-enter the paused agent execution with the reply.
      const resumeThis = node.resume && resumeNodeId === node.id && resumeExecutionId
      const result = (await runAgentExecution(
        resumeThis
          ? { agentId: node.agentId, organizationId: job.organizationId, userId: job.userId, executionId: resumeExecutionId, resume: true, reply: job.reply, onExecutionCreated, skipApprovalGate: true }
          : {
              agentId: node.agentId,
              organizationId: job.organizationId,
              userId: job.userId,
              input: node.input,
              onExecutionCreated,
              // Flows run end to end: the agent's own `requireApproval` gate
              // never pauses a flow run.
              skipApprovalGate: true,
              // Step-level agent configuration from the flow node (model /
              // memory / extra tool connections) — n8n-style sub-node parity.
              ...(node.overrides ? { stepOverrides: node.overrides } : {}),
            },
      )) as { summary?: string; status?: string; question?: string; executionId?: string }

      if (typeof result?.status === 'string' && result.status.startsWith('waiting')) {
        // Persist the pause reason on the step so the runs API can surface it.
        // The resume scan only reuses output for succeeded/skipped steps, so
        // this waiting-info output never leaks into resumed step data.
        const kind = result.status === 'waiting_for_approval' ? 'approval' : 'input'
        await finishStep({
          status: 'waiting',
          agentExecutionId: result.executionId ?? null,
          output: jsonValue({ waiting: { kind, question: result.question, approvalId: (result as { approvalId?: string }).approvalId } }),
          finishedAt: new Date(),
        })
        return { waiting: { status: result.status, question: result.question } }
      }
      const output = result?.summary ?? ''
      await finishStep({ status: 'succeeded', output: jsonValue(output), agentExecutionId: result.executionId ?? null, finishedAt: new Date() })
      return { output }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await finishStep({ status: 'failed', error: truncateWithMarker(message, 300), finishedAt: new Date() })
      return { error: message }
    }
  }

  // The idempotency scope for every side effect in this run. Normally the run
  // id; poll-triggered runs scope by the polled item instead, so a re-emitted
  // item replays rather than firing its writes again. See runScopeKey.
  const scopeKey = runScopeKey({ id: run.id, flowId: run.flowId, trigger: run.trigger })

  // Deterministic steps: MCP tool calls and HTTP requests. Same FlowRunStep
  // bookkeeping as agent steps so the run panel shows their input/output.
  //
  // NOTE on keys: the interpreter calls this with `id: stepKey`, which is the
  // per-iteration `${nodeId}#${index}` inside a loop (see interpret.ts's
  // runAction call sites). So `node.id` IS the iteration key — using it as the
  // ledger's iterationKey is per-iteration correct, exactly as the approval
  // correlation below already relies on.
  // The action-step executor lives in ./run-action-step. It was a 755-line
  // closure here — 78% of this function's body — and it closes over only the
  // values named below, which is what made moving it out possible. `nextOrder`
  // is a function rather than a number because the counter is SHARED: the
  // interpreter's container steps and these action steps draw from one
  // sequence, so the run panel shows them in the order they happened.
  const runActionStep = createRunActionStep({
    job,
    run,
    flow,
    scopeKey,
    nextOrder,
    pausedApprovalByNode,
    pausedSubflowRunByNode,
  })

  /**
   * "Always Output Data" (n8n parity): a step that succeeded but produced
   * nothing still emits an empty object, so the branch below it runs instead of
   * stalling on a value that never arrives. Off by default — a genuinely empty
   * result staying empty is the safer default for everything else.
   */
  const runAction: RunActionFn = async (node) =>
    applyAlwaysOutputData(await runActionStep(node), (node.config as { alwaysOutputData?: unknown }).alwaysOutputData)

  // Deploy-boundary safety: a run left `waiting` INSIDE a loop/parallel BEFORE
  // per-iteration keying shipped persisted its paused leaf under a BARE nodeId.
  // Resuming it now would neither match the reply (keyed `${id}#${index}`) nor
  // skip the already-run iterations — re-firing their side effects. A post-fix
  // pause carries a `#` suffix, so this only catches the pre-fix format. Fail
  // it closed with a clear message instead of re-running.
  if (resuming && resumeNodeId && !resumeNodeId.includes('#')) {
    const containerMembers = new Set(
      graph.nodes.flatMap((node) => (node.type === 'loop' ? node.data.body : node.type === 'parallel' ? node.data.branches.flat() : [])),
    )
    if (containerMembers.has(resumeNodeId)) {
      const error = 'This run was interrupted by an upgrade to loop handling and can’t be resumed safely — please re-run the flow.'
      await prisma.flowRun.update({
        where: { id: run.id, organizationId: job.organizationId },
        data: { status: 'failed', error, finishedAt: new Date() },
      })
      return { flowRunId: run.id, status: 'failed', output: null }
    }
  }

  // Context tokens. Freeze ONE clock so every `{{now}}` in this run agrees; on a
  // resume this is the resume moment (a fresh capture is correct). Run/flow
  // metadata rides alongside: `startedAt` is the run row's STORED start (never a
  // fresh Date), and `trigger` reads the run's own persisted provenance so a
  // resumed run keeps its original trigger. `url` is a builder deep-link PATH —
  // it carries no secret.
  const clock = new Date()
  const clockIso = clock.toISOString()
  const now = { iso: clockIso, date: clockIso.slice(0, 10), time: clockIso.slice(11, 19), unix: Math.floor(clock.getTime() / 1000) }

  /**
   * Capability token for this attempt's `webhook` wait callback.
   *
   * A run id is a database identifier, not a credential: it is shown to every
   * member who can read the run, written to logs, and handed to third parties
   * inside {{run.resumeUrl}}. Only the hash is stored, so the plaintext exists
   * solely in the URL the flow itself sends onward.
   *
   * Minted per EXECUTION ATTEMPT, not per run: resuming overwrites the hash, so
   * a delivered callback cannot be replayed, and a second webhook wait later in
   * the same flow still gets a live URL.
   */
  const hasWebhookWait = graph.nodes.some(
    (node) => node.type === 'wait' && (node.data as { mode?: string }).mode === 'webhook',
  )
  let resumeToken: string | null = null
  if (hasWebhookWait) {
    resumeToken = randomBytes(24).toString('hex')
    await prisma.flowRun.update({
      where: { id: run.id, organizationId: job.organizationId },
      data: { resumeTokenHash: hashToken(resumeToken) },
    })
  }

  const runMeta = {
    id: run.id,
    url: `/flows/${run.flowId}?run=${run.id}`,
    // Absolute public callback URL for a `webhook` wait: a pre-wait step sends
    // this to the external system, which POSTs back to resume the run. The
    // token above is the capability. Empty base URL degrades to a relative path
    // (dev) — harmless, since webhook waits need a real deployment.
    resumeUrl: `${process.env.NEXT_PUBLIC_APP_URL || ''}/api/flows/${run.flowId}/runs/${run.id}/resume${resumeToken ? `?token=${resumeToken}` : ''}`,
    trigger: (run.trigger as unknown as { type?: string } | null)?.type ?? 'manual',
    startedAt: run.startedAt.toISOString(),
    flowId: run.flowId,
    flowName: flow.name,
  }

  // Cooperative cancellation: the cancel API flips FlowRun.status to
  // 'cancelling'; the interpreter polls this once per tick and aborts. Throttle
  // the DB read so a fast flow doesn't hammer the row; once seen, stay cancelled.
  let lastCancelPoll = 0
  let cancelSeen = false
  let settingsTimedOut = false
  const isCancelled = async (): Promise<boolean> => {
    if (settingsTimedOut) return true
    if (cancelSeen) return true
    const nowMs = Date.now()
    if (nowMs - lastCancelPoll < 2000) return false
    lastCancelPoll = nowMs
    // Org-scoped: the tenant guard rejects an id-only read, and this call is
    // swallowed by .catch — an unscoped query here would silently disable
    // cancellation for every run instead of failing loudly.
    const fresh = await prisma.flowRun
      .findFirst({ where: { id: run.id, organizationId: job.organizationId }, select: { status: true } })
      .catch(() => null)
    cancelSeen = fresh?.status === 'cancelling' || fresh?.status === 'cancelled'
    return cancelSeen
  }

  let result
  try {
    const interpretation = interpretFlow(graph, input, {
      runAgent,
      runAction,
      onStep,
      now,
      run: runMeta,
      isCancelled,
      executionOrder: flowSettings.executionOrder,
      // Display labels (agent titles included) so hand-typed friendly-label
      // tokens like {{Previous Agent.output}} resolve to the right step.
      stepLabels: stepLabelsOf(graph, orgAgents),
      ...(resuming || replaySource || Object.keys(completed).length ? { completed, completedItems, completedRoutes } : {}),
      ...(Object.keys(completedProvenance).length ? { completedProvenance } : {}),
      ...(resuming ? { resumeNodeId, resumeReply: job.reply } : {}),
      ...(job.stopAfterNodeId ? { stopAfterNodeId: job.stopAfterNodeId } : {}),
      ...(job.stopBeforeNodeId ? { stopBeforeNodeId: job.stopBeforeNodeId } : {}),
    })
    if (flowSettings.timeoutSeconds) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        result = await Promise.race([
          interpretation,
          new Promise<Awaited<typeof interpretation>>((resolve) => {
            timer = setTimeout(() => {
              settingsTimedOut = true
              resolve({
                status: 'failed',
                steps: [],
                output: null,
                error: `Flow exceeded its ${flowSettings.timeoutSeconds}-second execution timeout.`,
              })
            }, flowSettings.timeoutSeconds! * 1000)
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    } else {
      result = await interpretation
    }
  } catch (error) {
    if (error instanceof FlowCancelledError) {
      // Terminalize as cancelled (not failed) + sweep still-running step rows.
      await Promise.all(pending).catch(() => undefined)
      await prisma.flowRun.update({
        where: { id: run.id, organizationId: job.organizationId },
        data: { status: 'cancelled', finishedAt: new Date() },
      })
      await prisma.flowRunStep.updateMany({
        where: { flowRunId: run.id, status: 'running' },
        data: { status: 'cancelled', finishedAt: new Date() },
      })
      return { flowRunId: run.id, status: 'cancelled', output: null }
    }
    throw error
  }
  // Everything after the interpreter returns — draining the detached step
  // writes, classifying the outcome, persisting the run row, broadcasting the
  // final tick, notifying — lives in ./finalize-flow-run. It is the one phase
  // with no bearing on how the run EXECUTED; it only records what happened.
  const { status, output } = await finalizeFlowRun({
    job,
    flow,
    run,
    graph,
    flowSettings,
    result,
    pending,
  })

  return { flowRunId: run.id, status, output }
}

/**
 * Entry point for callers that want queue durability (BullMQ stall recovery
 * and dead-letter) instead of running inline in the request process — used by
 * signal chains and cron schedule dispatch. In `inlineExecution` mode (dev/CI)
 * this is identical to calling `runFlowExecution` directly. Interactive
 * callers that must return immediately use startFlowExecution /
 * dispatchDetachedFlowExecution instead.
 */
export async function dispatchFlowExecution(
  job: FlowExecutionJob,
): Promise<{ flowRunId: string; status: string; output: unknown } | { queued: true }> {
  if (inlineExecution) return runFlowExecution(job)
  if (!workersEnabled) throw new Error('Flow worker is disabled')
  // Fail loud, not silent: with no live consumer (worker down, or listening on
  // a different Redis) an enqueued job would strand forever in `waiting`.
  await assertQueueConsumerAlive()
  const queue = createQueue(QUEUE_NAMES.FLOW_EXECUTION)
  await queue.add('execute-flow', injectTraceContext(job), flowJobOptions(job.flowRunId, undefined, job.deliveryId))
  return { queued: true }
}

// Detached inline executions in flight — a test seam only (see
// flushDetachedFlowExecutions); production inline processes are long-lived
// (next dev / node server), so the promises complete on their own.
const detachedFlowRuns = new Set<Promise<unknown>>()

/** Test seam: settle every detached inline flow execution started so far. */
export async function flushDetachedFlowExecutions(): Promise<void> {
  while (detachedFlowRuns.size) await Promise.allSettled([...detachedFlowRuns])
}

/**
 * Dispatch a flow job WITHOUT tying execution to the caller's lifetime: queue
 * mode enqueues the durable BullMQ job; inline mode (dev) runs it on a
 * detached promise. Either way the caller returns as soon as the job is
 * handed off — this is what lets a builder run keep executing after the user
 * navigates away from the page (the interactive execute route used to await
 * the whole run, so closing the tab aborted it mid-flight).
 */
export async function dispatchDetachedFlowExecution(job: FlowExecutionJob): Promise<void> {
  if (!inlineExecution) {
    if (!workersEnabled) throw new Error('Flow worker is disabled')
    // Throws when no worker heartbeat is fresh — startFlowExecution catches
    // this and terminalizes the prepared run, so the user sees "backend
    // offline" in seconds instead of "Thinking…" forever.
    await assertQueueConsumerAlive()
    const queue = createQueue(QUEUE_NAMES.FLOW_EXECUTION)
    await queue.add('execute-flow', injectTraceContext(job), flowJobOptions(job.flowRunId, job.preparedRunId, job.deliveryId))
    return
  }
  const detached = runFlowExecution(job)
    .catch(async (error) => {
      const message = error instanceof Error ? error.message : 'The flow run crashed before finishing.'
      apiLogger.error('detached flow execution failed', { flowId: job.flowId, flowRunId: job.preparedRunId ?? job.flowRunId, error: message })
      // A prepared run has a row to terminalize; resume failures either rolled
      // back to `waiting` (preamble) or were already persisted by the
      // interpreter's failure paths.
      if (job.preparedRunId) await failPreparedRun(job.preparedRunId, job.organizationId, message)
    })
    .finally(() => detachedFlowRuns.delete(detached))
  detachedFlowRuns.add(detached)
  // Without this the promise above is killed the instant the response is sent
  // on a serverless host, and the run does nothing at all. See keep-alive.ts.
  keepDetachedWorkAlive(detached)
}

/**
 * Start a fresh (or replayed-from-a-step) flow run durably: validate and
 * create the FlowRun row up front — so run history exists the moment this
 * returns — then hand execution to the detached dispatcher. Validation and
 * required-input errors still throw synchronously, so interactive callers get
 * immediate feedback; everything after that survives the caller going away.
 * Resumes (flowRunId + reply) go through dispatchDetachedFlowExecution
 * directly — their run row already exists.
 */
export async function startFlowExecution(
  job: FlowExecutionJob,
): Promise<{ flowRunId: string; status: string; output: unknown }> {
  const flow = await prisma.flow.findFirst({ where: { id: job.flowId, organizationId: job.organizationId } })
  if (!flow) throw new Error('Flow not found')
  const replaySource = await loadReplaySource(job)
  const { graph, manifest } = await resolveValidatedGraph(job, flow, null, replaySource)
  let input: unknown = job.input ?? ''
  // A replay re-runs the SOURCE run's input by default — explicit input wins.
  if (replaySource && job.input === undefined) input = storedRunInput(replaySource.input)
  const resolved = await resolveFreshRunInput(job, flow, graph, input)
  const run = await createFlowRunRow(job, flow, graph, resolved.input, resolved.reusedInput, manifest)
  try {
    // job.input carries the RESOLVED input so the worker executes exactly what
    // was validated + persisted here (no re-resolution drift).
    await dispatchDetachedFlowExecution({ ...job, input: resolved.input, preparedRunId: run.id })
  } catch (error) {
    await failPreparedRun(run.id, job.organizationId, error instanceof Error ? error.message : 'Could not start the flow run.')
    throw error
  }
  return { flowRunId: run.id, status: 'running', output: null }
}

/** BullMQ job handler — the worker calls this for each dequeued flow job. */
export async function executeFlowJob(job: Job<FlowExecutionJob>): Promise<{ flowRunId: string; status: string; output: unknown }> {
  return withExtractedTraceContext(job.data.traceContext, () => runFlowExecution(job.data))
}
