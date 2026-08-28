import { prisma } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'
import { chooseWaitingReply } from '@/lib/flows/run-waiting'
import { flowGraphSchema } from '@/lib/flows/graph'
import { parseStateOverrides, resolveOverride } from '@/lib/flows/state-overrides'
import { REDACTED_AT_REST_WARNING } from '@/lib/flows/run-data-guard'
import { shouldPersistInterpreterStep, jsonValue } from './run-step-persistence'
import type { FlowItem } from '@/lib/flows/items'
import type { FlowExecutionJob } from './execute-flow'

type FlowGraph = ReturnType<typeof flowGraphSchema.parse>
type FlowRunRow = NonNullable<Awaited<ReturnType<typeof prisma.flowRun.findFirst>>>

/**
 * The state the interpreter starts from.
 *
 * A fresh run starts from nothing; a resume, a patch-and-replay, a re-run-from-
 * step, a pinned node, or a state override all start from something. Working
 * out WHAT — which nodes count as already done, which of their outputs are
 * replayable, which paused approval or child run this resume is un-pausing,
 * where the step numbering continues from — was ~290 lines in the middle of
 * `runFlowExecutionInner`, ahead of any of the code that used it.
 *
 * Everything here is seeding. Nothing here executes a node.
 */
export interface SeededRunState {
  nodeTypeById: Map<string, string | undefined>
  /** Node ids (per-iteration keyed inside loops) already done, with their output. */
  completed: Record<string, unknown>
  completedItems: Record<string, FlowItem[]>
  completedRoutes: Set<string>
  /** Per-node log line explaining WHY a node counts as done without running. */
  completedProvenance: Record<string, string>
  /** The paused node this resume re-enters, if any. */
  resumeNodeId: string | undefined
  resumeExecutionId: string | undefined
  pausedApprovalByNode: Map<string, string>
  pausedSubflowRunByNode: Map<string, string>
  /**
   * The shared step ordinal, already advanced past every row this seeding
   * wrote. Every later writer — the interpreter's recorder and the action-step
   * executor — draws from this one counter so the run panel orders rows as they
   * actually happened.
   */
  nextOrder: () => number
  /**
   * Detached row writes started by the seeding (skipped-node rows for pins and
   * overrides). The engine drains this once, at finalize, together with the
   * writes the walk itself adds.
   */
  pending: Promise<unknown>[]
}

export async function seedRunState(params: {
  job: FlowExecutionJob
  run: FlowRunRow
  graph: FlowGraph
  resuming: boolean
  patching: boolean
  replaySource: FlowRunRow | null
}): Promise<SeededRunState> {
  const { job, run, graph, resuming, patching, replaySource } = params
  const nodeTypeById = new Map(graph.nodes.map((node) => [node.id, node.type]))
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const completedRoutes = new Set<string>()
  // Resume state: nodes that already succeeded are skipped (reusing their
  // stored output); the paused step is re-run with the reply injected. Step
  // rows inside a loop are keyed per iteration (`${nodeId}#${index}`), so
  // `completed` and the resume target are keyed by that exact nodeId — a
  // mid-loop pause resumes ONLY the paused iteration, never re-running prior
  // iterations' side effects.
  const completed: Record<string, unknown> = {}
  const completedItems: Record<string, FlowItem[]> = {}
  // Pin/override provenance, keyed exactly like `completed` — read by
  // interpret.ts's resume-replay branch (`opts.completedProvenance`) so an
  // INTERPRETER-NATIVE node type (condition/loop/parallel/stop/variable/…)
  // carries the same log line on the row IT writes for itself, every single
  // time the walk reaches it (every resume attempt re-walks the whole graph
  // and re-emits a fresh row for each already-completed node — see the
  // `opts.completed` branch in interpret.ts — so this must be set on every
  // invocation, not just the first).
  //
  // Declared up here (rather than beside the pinData/stateOverrides seeding
  // below) so the resume-seeding loop just below can ALSO populate it: a
  // step whose persisted `warnings` carry REDACTED_AT_REST_WARNING (see
  // run-data-guard.ts) had its stored output masked at rest, and a plain
  // resume/patch/replay would otherwise replay that masked value with no
  // signal that it is not the real one (X1 in the design spec).
  const completedProvenance: Record<string, string> = {}
  const REPLAYED_REDACTED_NOTE = 'replayed from a redacted stored output — values may be masked'
  // The redaction guard (run-data-guard.ts) appends REDACTED_AT_REST_WARNING
  // to a step's persisted `warnings` when it masks that step's stored output.
  // A resume/patch/replay that seeds `completed[nodeId]` from such a step
  // must not silently hand the masked value onward with no signal — flag it
  // via completedProvenance instead (X1 in the design spec).
  const stepWasRedacted = (step: { warnings: unknown }): boolean =>
    Array.isArray(step.warnings) && step.warnings.includes(REDACTED_AT_REST_WARNING)
  let resumeNodeId: string | undefined
  let resumeExecutionId: string | undefined
  // The approval id each paused leaf node (`${nodeId}#${index}` inside a loop)
  // paused on. On resume each iteration consumes ONLY its own decision — a
  // decision for iteration i is never misattributed to iteration 0 when the
  // loop re-enters, and each approval id is unique so it is consumed once.
  const pausedApprovalByNode = new Map<string, string>()
  // Paused CHILD flow runs per subflow step — a parent resume forwards the
  // reply into the child run instead of re-executing it from scratch.
  const pausedSubflowRunByNode = new Map<string, string>()
  // Every leaf pause this run is blocked on, keyed by step id. A loop with
  // concurrency above 1 — or a parallel node with a review in more than one
  // branch — pauses SEVERAL iterations at once, so the reply has to say which
  // one it answers (job.replyStepKey).
  const waitingLeaves = new Map<string, { nodeId: string; executionId?: string }>()
  let order = 0
  if (resuming) {
    const priorSteps = await prisma.flowRunStep.findMany({ where: { flowRunId: run.id }, orderBy: { order: 'asc' } })
    for (const step of priorSteps) {
      // Succeeded/skipped steps replay from their stored output. A FAILED step
      // whose node has onError 'continue'/'route' ALSO replays (its stored
      // output is the {error, input} pass-through object) — and route
      // failures are tracked in `completedRoutes` so the interpreter re-takes
      // the error edge instead of diverting down the normal path. This makes
      // resumed runs deterministic even when the transient failure has
      // cleared: the run repeats the path it actually took.
      if (step.status === 'succeeded' || step.status === 'skipped') {
        completed[step.nodeId] = step.output
        if (Array.isArray(step.items)) completedItems[step.nodeId] = step.items as unknown as FlowItem[]
        if (stepWasRedacted(step)) completedProvenance[step.nodeId] = REPLAYED_REDACTED_NOTE
      }
      if (step.status === 'failed') {
        const baseNode = nodeById.get(step.nodeId.split('#')[0])
        const onError = baseNode && 'onError' in baseNode.data ? (baseNode.data as { onError?: string }).onError : undefined
        if ((onError === 'route' || onError === 'continue') && step.output !== null && step.output !== undefined) {
          completed[step.nodeId] = step.output
          if (Array.isArray(step.items)) completedItems[step.nodeId] = step.items as unknown as FlowItem[]
          if (onError === 'route') completedRoutes.add(step.nodeId)
          if (stepWasRedacted(step)) completedProvenance[step.nodeId] = REPLAYED_REDACTED_NOTE
        }
      }
      if (step.status === 'waiting') {
        // A loop/parallel container persists its OWN `waiting` row for display,
        // but only the leaf node inside it actually resumes. Skip container rows
        // so the reply targets the paused leaf (`${nodeId}#${index}`), not the
        // container (whose row sorts after the leaf and would otherwise win).
        const baseType = nodeTypeById.get(step.nodeId.split('#')[0])
        if (baseType === 'loop' || baseType === 'parallel') continue
        // Keyed by step id, so a stale unresolved row and the live row for the
        // same iteration collapse to one candidate (rows arrive in order asc,
        // the later one wins).
        waitingLeaves.set(step.nodeId, { nodeId: step.nodeId, executionId: step.agentExecutionId ?? undefined })
        const approvalId = (step.output as { waiting?: { approvalId?: string } } | null)?.waiting?.approvalId
        if (typeof approvalId === 'string' && approvalId) pausedApprovalByNode.set(step.nodeId, approvalId)
        const childRunId = (step.output as { waiting?: { childRunId?: string } } | null)?.waiting?.childRunId
        if (typeof childRunId === 'string' && childRunId) pausedSubflowRunByNode.set(step.nodeId, childRunId)
      }
    }
    // Which pause does this reply answer? With exactly one waiting leaf there
    // is nothing to choose (and every reply written before per-iteration keying
    // carries no key, so that path must keep working). With several — a loop
    // that paused three reviews at once — a key is REQUIRED: picking one
    // silently would answer the wrong item and resolve the others with someone
    // else's words. Roll the claim back to `waiting` so the run stays
    // answerable, and say what to do.
    const routed = chooseWaitingReply([...waitingLeaves.values()], job.replyStepKey)
    if (routed && 'error' in routed) {
      await prisma.flowRun.updateMany({
        where: { id: run.id, organizationId: job.organizationId, status: 'running' },
        data: { status: 'waiting' },
      })
      throw new ApiError(routed.error, 409, routed.code)
    }
    resumeNodeId = routed?.target.nodeId
    resumeExecutionId = routed?.target.executionId
    // Resuming creates NEW step rows for the re-run node — resolve every stale
    // waiting row now so it can never shadow a later pause in deriveRunWaiting,
    // and continue the order counter after all prior rows so new steps always
    // sort after old ones.
    await prisma.flowRunStep.updateMany({
      where: { flowRunId: run.id, status: 'waiting' },
      data: { status: 'resumed', finishedAt: new Date() },
    })
    // A resumed run's un-decided approvals are stale: any step that doesn't
    // consume THIS decision falls through and re-queues a fresh approval, so
    // an old pending one must never stay actionable (approving both would run
    // the write twice). decideApproval refuses non-pending requests, so a
    // superseded approval is inert — deciding it just reports its state.
    await prisma.approvalRequest.updateMany({
      where: { organizationId: job.organizationId, executionId: run.id, status: 'pending' },
      data: { status: 'superseded' },
    })
    if (priorSteps.length) order = Math.max(...priorSteps.map((step) => step.order)) + 1
  }

  // Patch-and-resume: same run, re-executed from the chosen step. Seeds from
  // the run's OWN prior rows below the cutoff, then APPENDS new rows after the
  // existing max order rather than deleting anything — so the original failed
  // row survives as evidence of what actually happened, and a second
  // patch-resume composes with no special handling (each node's latest row
  // below the cutoff wins, because rows are read in ascending order).
  if (patching && job.resumeFrom) {
    const priorSteps = await prisma.flowRunStep.findMany({ where: { flowRunId: run.id }, orderBy: { order: 'asc' } })
    const target = job.resumeFrom.nodeId
    const firstTargetRow = priorSteps.find((step) => step.nodeId === target || step.nodeId.startsWith(`${target}#`))
    const cutoff = firstTargetRow ? firstTargetRow.order : Number.POSITIVE_INFINITY
    for (const step of priorSteps) {
      if (step.order >= cutoff) continue
      if (step.status === 'succeeded' || step.status === 'skipped') {
        completed[step.nodeId] = step.output
        if (Array.isArray(step.items)) completedItems[step.nodeId] = step.items as unknown as FlowItem[]
        if (stepWasRedacted(step)) completedProvenance[step.nodeId] = REPLAYED_REDACTED_NOTE
      }
      if (step.status === 'failed') {
        const baseNode = nodeById.get(step.nodeId.split('#')[0])
        const onError = baseNode && 'onError' in baseNode.data ? (baseNode.data as { onError?: string }).onError : undefined
        if ((onError === 'route' || onError === 'continue') && step.output !== null && step.output !== undefined) {
          completed[step.nodeId] = step.output
          if (Array.isArray(step.items)) completedItems[step.nodeId] = step.items as unknown as FlowItem[]
          if (onError === 'route') completedRoutes.add(step.nodeId)
          if (stepWasRedacted(step)) completedProvenance[step.nodeId] = REPLAYED_REDACTED_NOTE
        }
      }
    }
    // Stale waiting rows would otherwise shadow a later pause, exactly as on
    // the resume path.
    await prisma.flowRunStep.updateMany({
      where: { flowRunId: run.id, status: 'waiting' },
      data: { status: 'resumed', finishedAt: new Date() },
    })
    if (priorSteps.length) order = Math.max(...priorSteps.map((step) => step.order)) + 1
  }

  // Re-run from a step: replay every outcome recorded BEFORE the chosen step,
  // then let the walk execute it (and everything after) fresh. The cutoff is
  // the chosen node's first recorded row order; container iterations carry
  // their own `node#i` rows, so the whole loop replays or re-runs coherently.
  if (replaySource && job.replayFrom) {
    const priorSteps = await prisma.flowRunStep.findMany({ where: { flowRunId: replaySource.id }, orderBy: { order: 'asc' } })
    const target = job.replayFrom.nodeId
    const firstTargetRow = priorSteps.find((step) => step.nodeId === target || step.nodeId.startsWith(`${target}#`))
    const cutoff = firstTargetRow ? firstTargetRow.order : Number.POSITIVE_INFINITY
    for (const step of priorSteps) {
      if (step.order >= cutoff) continue
      if (step.status === 'succeeded' || step.status === 'skipped') {
        completed[step.nodeId] = step.output
        if (Array.isArray(step.items)) completedItems[step.nodeId] = step.items as unknown as FlowItem[]
        if (stepWasRedacted(step)) completedProvenance[step.nodeId] = REPLAYED_REDACTED_NOTE
      }
      if (step.status === 'failed') {
        const baseNode = nodeById.get(step.nodeId.split('#')[0])
        const onError = baseNode && 'onError' in baseNode.data ? (baseNode.data as { onError?: string }).onError : undefined
        if ((onError === 'route' || onError === 'continue') && step.output !== null && step.output !== undefined) {
          completed[step.nodeId] = step.output
          if (Array.isArray(step.items)) completedItems[step.nodeId] = step.items as unknown as FlowItem[]
          if (onError === 'route') completedRoutes.add(step.nodeId)
          if (stepWasRedacted(step)) completedProvenance[step.nodeId] = REPLAYED_REDACTED_NOTE
        }
      }
    }
  }

  // Container (condition/loop/parallel/stop) outcomes are reported via onStep;
  // persist them so runs are fully inspectable. Agent/tool/http steps are
  // persisted by their adapters because they need started/running rows. The
  // node type is looked up by the BARE `outcome.nodeId`; the row is keyed by
  // `outcome.iterationKey` (the per-iteration `${nodeId}#${index}` inside a
  // loop, or the bare id on the main chain).
  //
  // Declared before the pinData/stateOverrides seeding below so THOSE writes
  // (which also need to land before finalize) can share the same array.
  const pending: Promise<unknown>[] = []

  // A node marked pre-completed below (pinData/stateOverrides) never runs the
  // interpreter, so nothing would ever call onStep for it — before this fix
  // that meant NO FlowRunStep row at all, and anything downstream of it had no
  // way to tell "this input came from a pinned/overridden value" from "this
  // input came from a step that actually ran". A `skipped` row with a log line
  // makes the substitution visible in the same run panel that shows every
  // other step, using a status the UI already renders.
  //
  // `completedProvenance` itself is declared above, alongside `completed` —
  // it must be populated by the resume-seeding loop too (see there), not just
  // by the pinData/stateOverrides seeding below.

  // The explicit row write below is for ADAPTER_PERSISTED_TYPES (agent/tool/
  // http/ai/subflow/code/knowledge — see run-step-persistence.ts) ONLY: those
  // are the types whose row is normally written by the adapter, which a
  // pre-completed node never reaches, so nothing else will ever write one.
  // Every other node type is persisted generically by interpret.ts itself
  // (via `completedProvenance` above), so writing a row here for those would
  // duplicate it.
  //
  // `alreadyRecorded` guards THIS explicit write against a duplicate on
  // resume/patch/replay: unlike the interpreter's own emit (which produces a
  // genuinely new row per attempt, appended alongside earlier ones by
  // design), this create() has no such attempt-scoping — by the time this
  // section runs, `completed` may already hold this nodeId's value from a
  // prior row read out of the DB above (including a skipped-pin row this very
  // section wrote on an earlier attempt), so the row already exists and only
  // the replayed VALUE should win here, not a second row.
  const recordSkippedSeed = (nodeId: string, value: unknown, log: string, alreadyRecorded: boolean) => {
    completedProvenance[nodeId] = log
    if (alreadyRecorded || shouldPersistInterpreterStep(nodeTypeById.get(nodeId.split('#')[0]))) return
    const seedOrder = order++
    pending.push(
      prisma.flowRunStep
        .create({
          data: {
            flowRunId: run.id,
            nodeId,
            order: seedOrder,
            status: 'skipped',
            input: jsonValue({}),
            output: jsonValue(value ?? null),
            logs: jsonValue([log]),
            startedAt: new Date(),
            finishedAt: new Date(),
          },
        })
        .catch(() => undefined),
    )
  }

  // Pinned/mock outputs: seed them as pre-completed so those nodes are not run
  // and downstream steps consume the pinned value (n8n pinData semantics). A
  // pin wins over a replayed output — it is the user's explicit override.
  if (graph.pinData) {
    for (const [nodeId, value] of Object.entries(graph.pinData)) {
      if (!nodeById.has(nodeId)) continue
      const alreadyRecorded = nodeId in completed
      completed[nodeId] = value ?? null
      recordSkippedSeed(nodeId, value, 'value pinned — node not executed', alreadyRecorded)
    }
  }

  // Per-run overrides beat both pins and replayed outputs: they are the most
  // specific intent expressed, scoped to THIS run, and — unlike pinData —
  // never touch the shared flow draft.
  const overrides = parseStateOverrides(run.stateOverrides)
  if (overrides) {
    for (const nodeId of nodeById.keys()) {
      const { hit, value } = resolveOverride(overrides, nodeId)
      if (!hit) continue
      const alreadyRecorded = nodeId in completed
      completed[nodeId] = value
      recordSkippedSeed(nodeId, value, 'state override — node not executed', alreadyRecorded)
    }
    // Iteration-specific keys name rows (`node#i`) that are not bare graph
    // nodes, so they need seeding directly.
    for (const key of Object.keys(overrides)) {
      if (!key.includes('#') || !nodeById.has(key.split('#')[0])) continue
      const alreadyRecorded = key in completed
      completed[key] = overrides[key]
      recordSkippedSeed(key, overrides[key], 'state override — node not executed', alreadyRecorded)
    }
  }

  return {
    nodeTypeById,
    completed,
    completedItems,
    completedRoutes,
    completedProvenance,
    resumeNodeId,
    resumeExecutionId,
    pausedApprovalByNode,
    pausedSubflowRunByNode,
    nextOrder: () => order++,
    pending,
  }
}
