import { randomBytes } from 'node:crypto'
import type { Job } from 'bullmq'
import { ambientOrganization } from '@/lib/tenant-database-context'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { hashToken } from '@/lib/crypto/secrets'
import { applyAlwaysOutputData, keepDetachedWorkAlive, trackDetached } from '@/lib/flows/keep-alive'
import { buildFlowAiLedgerContext } from '@/lib/flows/ai-step-ledger'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { assertQueueConsumerAlive } from '@/lib/queue/heartbeat'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { flowJobOptions } from '@/lib/flows/queue-options'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { parseApprovalDecision, shouldConsumeApprovalDecision } from '@/lib/flows/approval-decision'
import { REDACTED_AT_REST_WARNING } from '@/lib/flows/run-data-guard'
import { notify } from '@/lib/notifications/service'
import { apiLogger } from '@/lib/logger'
import { recordAudit } from '@/lib/audit'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { ApiError } from '@/lib/server/api-handler'
import { chooseWaitingReply } from '@/lib/flows/run-waiting'
import { triggerFromGraph, triggerInputFieldsFromTrigger } from '@/lib/flows/trigger'
import { applyInputDefaults, missingRequiredInputFields } from '@/lib/flows/input-validation'
import { shouldReuseInput, storedRunInput } from '@/lib/flows/reuse-input'
import { stepLabelsOf } from '@/lib/flows/token-text'
import { interpretFlow, FlowCancelledError, type RunAgentFn, type RunActionFn } from './interpret'
import { flowActionRetries, flowActionTimeoutMs, runWithRetries, shouldRetryAfterTimeout, classifyRetry, type RetryEvidenceError } from './action-reliability'
import { runHttpWithRetries } from './http-retry'
import { prepareHttpRequest, responseOutput, redactHttpStepInput, withBearerAuthorization, type FlowHttpOutput } from './http'
import { getByPath, setQueryParam, pageItems, optimizeForAi, paginationComplete } from '@/lib/flows/http-pagination'
import { fileReference, bodyHasFileReference, buildMultipartBody } from '@/lib/flows/file-ref'
import { broadcastFlowRunTick } from '@/lib/flows/run-stream'
import { saveStoredFile, readStoredFile, STORED_FILE_MAX_BYTES } from '@/lib/files/storage'
import { readResponseBytesLimited } from '@/lib/net/response-body'
import { extractTextAuto, isSupported } from '@/lib/knowledge/extract'
import {
  fetchWithHttpCredential,
  markCredentialResult,
  resolveHttpConnectionToken,
  resolveHttpCredential,
  type ResolvedHttpCredential,
} from './http-auth'
import { shouldPersistInterpreterStep, persistedCodeStepInput } from './run-step-persistence'
import { truncateWithMarker } from '@/lib/flows/truncate'
import { prepareToolArgs, applySlackThreadDefault } from './tool-args'
import { flowToolOutput } from './tool-output'
import { structuredResponseInstruction, parseStructuredAgentOutput } from './agent-response'
import { buildAiPrompt, type AiPromptInput } from '@/lib/flows/ai-prompts'
import { aiEgressRefusal, recordPiiEgress } from '@/lib/usage/ai-guard'
import { blockedCallMessage, inspectToolArgs, recordToolCallGuardEvent } from '@/lib/security/tool-call-guard'
import { createModelRunner, billableTokens, DEFAULT_AGENT_MODEL, DEFAULT_SUMMARY_MODEL } from '@/lib/llm/model-runner'
import { subflowChildInput, subflowGuard } from '@/lib/flows/subflow'
import { parseStateOverrides, resolveOverride } from '@/lib/flows/state-overrides'
import { retrieveKnowledge } from '@/lib/knowledge/retrieve'
import { AGENT_RUN_TIMEOUT_MS } from '@/lib/agents/timeouts'
import { recordTokenUsage } from '@/lib/usage/budget'
import { modelAllowanceFor } from '@/lib/usage/model-allowance'
import { downgradeNotice } from '@/lib/usage/model-tiers'
import { maybeShadowFlowAiStep } from '@/lib/eval/shadow'
import { runFlowCode } from './code-runner'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { buildFlowExecutionManifest, executionManifestMatches, type FlowExecutionManifest } from '@/lib/flows/execution-manifest'
import { flowSideEffectKey, withIdempotencyHeader } from '@/lib/flows/idempotency'
import { runScopeKey, readLedger, writeLedger, LEDGER_REPLAY_WARNING } from '@/lib/flows/side-effect-ledger'
import { flowSignalOutboxEvent } from '@/lib/outbox'

export type FlowExecutionJob = {
  flowId: string
  organizationId: string
  userId: string
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
  trigger?: { type: 'manual' | 'schedule' | 'webhook' | 'signal' | 'subflow' | 'poll' | 'activity' | 'slack'; [key: string]: unknown }
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

// Bound HTTP responses so downstream prompts/logs stay manageable.
const HTTP_MAX_RESPONSE_CHARS = 50_000

/** Best-effort download filename: Content-Disposition, else the URL's last path
 *  segment, else a generic name. */
function httpDownloadFilename(contentDisposition: string | null, url: string): string {
  const match = contentDisposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]).replace(/[\r\n/\\]/g, ' ').trim().slice(0, 200) || 'download'
    } catch {
      return match[1].replace(/[\r\n/\\]/g, ' ').trim().slice(0, 200) || 'download'
    }
  }
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean).at(-1)
    if (segment) return decodeURIComponent(segment).slice(0, 200)
  } catch {
    /* fall through */
  }
  return 'download'
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

/**
 * Retry evidence is only evidence when a retry actually happened. `retries:0`
 * (or any chain that fails on its very first and only attempt) still yields
 * one `attemptErrors` entry — persisting it would just duplicate the `error`
 * field verbatim. Gate on `attempts > 1` (more than one call was actually
 * made) rather than `attemptErrors.length` (which is 1 for that no-retry
 * case too).
 */
export function retryWarnings(attempts: number, attemptErrors: string[]): string[] {
  return attempts > 1 ? attemptErrors : []
}

function signalDepthOfTrigger(trigger: FlowExecutionJob['trigger']): number {
  return typeof trigger?.depth === 'number' ? trigger.depth : 0
}

// Write planes are the consequential audit entries — the same set the agent
// loop uses for its tool.write / tool.call distinction.
const WRITE_PLANES = /^(nango|slack|email|backstory)/i

/** What a paused child flow is asking, for the parent's waiting banner. */
async function subflowChildQuestion(childRunId: string, childName: string): Promise<string> {
  // FlowRunStep is transitively org-scoped (no organizationId column); the
  // child run id comes from this run's own org-scoped write, so a bare
  // flowRunId read cannot cross tenants.
  const waitingStep = await prisma.flowRunStep.findFirst({
    where: { flowRunId: childRunId, status: 'waiting' },
    orderBy: { order: 'desc' },
  }).catch(() => null)
  const question = (waitingStep?.output as { waiting?: { question?: string } } | null)?.waiting?.question
  return question ? `${childName}: ${question}` : `"${childName}" paused to ask for input.`
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
  const usedConnectionIds = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'tool' || node.type === 'http'
      ? [node.data.connectionId]
      : node.type === 'agent'
        ? node.data.toolConnectionIds ?? []
        : [],
  ).filter((id): id is string => Boolean(id))))
  const usedHttpCredentialIds = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'http' ? [node.data.credentialId] : [],
  ).filter((id): id is string => Boolean(id))))
  const [agents, toolCatalog, httpCredentials] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId: job.organizationId, status: 'ACTIVE', ...agentVisibilityScope(job.userId) },
      select: { id: true, description: true, updatedAt: true },
      take: 500,
    }),
    usedConnectionIds.length
      ? loadFlowToolCatalog(job.organizationId, { userId: job.userId, connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length, takeTools: 100 })
      : Promise.resolve([]),
    usedHttpCredentialIds.length
      ? prisma.httpCredential.findMany({
          where: { organizationId: job.organizationId, id: { in: usedHttpCredentialIds }, status: { in: ['verified', 'error'] } },
          select: { id: true },
        })
      : Promise.resolve([]),
  ])
  const agentRefs = agents.map((agent) => ({ id: agent.id, title: agent.description }))
  const validation = validateFlowGraph(graph, {
    agents: agentRefs,
    toolCatalog,
    httpCredentials,
    flowId: job.flowId,
  })
  if (!validation.ok) {
    throw new ApiError(validationErrorMessage(validation), 400, 'FLOW_VALIDATION_ERROR')
  }
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
  return ambientOrganization.run(job.organizationId, () => runFlowExecutionInner(job))
}

async function runFlowExecutionInner(
  job: FlowExecutionJob,
): Promise<{ flowRunId: string; status: string; output: unknown }> {
  const flow = await prisma.flow.findFirst({ where: { id: job.flowId, organizationId: job.organizationId } })
  if (!flow) throw new Error('Flow not found')
  const resuming = Boolean(job.flowRunId && job.reply !== undefined)
  // Patch-and-resume: same run row, re-executed from a chosen step. Carries a
  // flowRunId but no reply, so it never collides with the resume path above.
  const patching = Boolean(job.flowRunId && job.resumeFrom && !resuming)
  const prepared = Boolean(job.preparedRunId) && !resuming && !patching

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
      await prisma.flowRun.updateMany({
        where: { id: job.flowRunId, organizationId: job.organizationId, status: 'running' },
        data: { status: 'waiting' },
      })
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
        if (stepWasRedacted(step)) completedProvenance[step.nodeId] = REPLAYED_REDACTED_NOTE
      }
      if (step.status === 'failed') {
        const baseNode = nodeById.get(step.nodeId.split('#')[0])
        const onError = baseNode && 'onError' in baseNode.data ? (baseNode.data as { onError?: string }).onError : undefined
        if ((onError === 'route' || onError === 'continue') && step.output !== null && step.output !== undefined) {
          completed[step.nodeId] = step.output
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
        if (stepWasRedacted(step)) completedProvenance[step.nodeId] = REPLAYED_REDACTED_NOTE
      }
      if (step.status === 'failed') {
        const baseNode = nodeById.get(step.nodeId.split('#')[0])
        const onError = baseNode && 'onError' in baseNode.data ? (baseNode.data as { onError?: string }).onError : undefined
        if ((onError === 'route' || onError === 'continue') && step.output !== null && step.output !== undefined) {
          completed[step.nodeId] = step.output
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
        if (stepWasRedacted(step)) completedProvenance[step.nodeId] = REPLAYED_REDACTED_NOTE
      }
      if (step.status === 'failed') {
        const baseNode = nodeById.get(step.nodeId.split('#')[0])
        const onError = baseNode && 'onError' in baseNode.data ? (baseNode.data as { onError?: string }).onError : undefined
        if ((onError === 'route' || onError === 'continue') && step.output !== null && step.output !== undefined) {
          completed[step.nodeId] = step.output
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
  const onStep = (outcome: { nodeId: string; iterationKey?: string; status: string; input?: unknown; output?: unknown; error?: string; warnings?: string[]; logs?: string[]; startedAt: Date; finishedAt: Date }) => {
    // Realtime nudge: tell the builder a step changed so it refreshes at once
    // (no output on the wire — see run-stream.ts). Fire-and-forget; no-op locally.
    trackDetached(broadcastFlowRunTick(run.id, { nodeId: outcome.nodeId, status: outcome.status }))
    const rowKey = outcome.iterationKey ?? outcome.nodeId
    if (!shouldPersistInterpreterStep(nodeTypeById.get(outcome.nodeId))) {
      // Adapter (agent/tool/http/ai/subflow/code/knowledge) rows are written
      // by the adapter — but the value DOWNSTREAM CONSUMED is computed after
      // the adapter returns (asStructured / structured-output parse), so:
      // - success: overwrite the row's output with the consumed value, so the
      //   run panel shows what later steps actually read AND a resume replays
      //   the step from the consumed shape (a structured agent replayed from
      //   its raw text would break every {{step.x.output.field}} reference).
      // - per-item aggregate: the children each have a #i row, but the
      //   aggregate array had no row anywhere — create it when the update
      //   matched nothing.
      if (outcome.status === 'succeeded' && outcome.output !== undefined) {
        const aggregateOrder = order++
        pending.push(
          // The check-then-write (updateMany, then create only if it matched
          // nothing) is a single transaction so two concurrent per-item
          // completions racing this same rowKey can't both see count 0 and
          // both create a duplicate aggregate row.
          prisma.$transaction(async (tx) => {
            // Warnings only ever ADD here (never null out): the interpreter's
            // producers (empty result, item-policy counts) and any adapter-side
            // note are disjoint by construction, so a present outcome.warnings
            // is authoritative for this row.
            const warningsPatch = outcome.warnings?.length ? { warnings: jsonValue(outcome.warnings) } : {}
            const updated = await tx.flowRunStep.updateMany({
              where: { flowRunId: run.id, nodeId: rowKey, status: 'succeeded' },
              data: { output: jsonValue(outcome.output), ...warningsPatch },
            })
            if (updated.count === 0) {
              await tx.flowRunStep.create({
                data: {
                  flowRunId: run.id,
                  nodeId: rowKey,
                  order: aggregateOrder,
                  status: 'succeeded',
                  input: jsonValue(outcome.input ?? {}),
                  output: jsonValue(outcome.output ?? null),
                  ...warningsPatch,
                  startedAt: outcome.startedAt,
                  finishedAt: outcome.finishedAt,
                },
              })
            }
          }).catch(() => undefined),
        )
        return
      }
      // The adapter stores NULL output on failure. For an onError
      // route/continue failure the interpreter computed the {error, input}
      // pass-through here — backfill it onto the failed row so a RESUME
      // replays this step from its stored output (and re-takes the error
      // edge) instead of re-executing it, which would duplicate an external
      // write and could diverge the path if the transient error has since
      // cleared. Other emits are no-ops.
      if (outcome.status === 'failed') {
        const failedOrder = order++
        pending.push(
          // Same reasoning as the succeeded branch: the check-then-write
          // (updateMany/count, then create only if nothing matched) is one
          // transaction so a concurrent emit for the same rowKey can't both
          // observe "no row" and both create a duplicate.
          prisma.$transaction(async (tx) => {
            // Same additive rule as the succeeded branch above: warnings only
            // ever ADD. Needed here so a retried 'agent' step (whose row is
            // created/finished per attempt by `runAgent`, before this attempt
            // count exists) still gets its attempt-error trail persisted even
            // when the failure itself carries no output patch.
            const warningsPatch = outcome.warnings?.length ? { warnings: jsonValue(outcome.warnings) } : {}
            if (outcome.output !== undefined || Object.keys(warningsPatch).length) {
              const updated = await tx.flowRunStep.updateMany({
                where: { flowRunId: run.id, nodeId: rowKey, status: 'failed' },
                data: { ...(outcome.output !== undefined ? { output: jsonValue(outcome.output) } : {}), ...warningsPatch },
              })
              if (updated.count > 0) return
            }
            // A resolution failure (missing/foreign data reference) fails the
            // step BEFORE its adapter runs, so no row exists at all — without
            // this create the run fails with zero steps and nothing names the
            // offending node. Only create when NO row exists for this key: a
            // timed-out adapter leaves a 'running' row the end-of-run sweep
            // closes, and a second row here would duplicate it.
            const existing = await tx.flowRunStep.count({ where: { flowRunId: run.id, nodeId: rowKey } })
            if (existing === 0) {
              await tx.flowRunStep.create({
                data: {
                  flowRunId: run.id,
                  nodeId: rowKey,
                  order: failedOrder,
                  status: 'failed',
                  input: jsonValue(outcome.input ?? {}),
                  output: jsonValue(outcome.output ?? null),
                  error: outcome.error ? truncateWithMarker(outcome.error, 300) : null,
                  ...warningsPatch,
                  startedAt: outcome.startedAt,
                  finishedAt: outcome.finishedAt,
                },
              })
            }
          }).catch(() => undefined),
        )
      }
      // A retried 'agent' step that ends up pausing for human input: its row
      // is created/finished as 'waiting' by `runAgent` (one call per attempt,
      // unaware of the retry loop wrapping it), so the aggregate attempt
      // trail — only known here, after runAgentWithReliability returns — must
      // be patched on additively, same rule as succeeded/failed above. No-op
      // for every other emit shape (nothing else emits 'waiting' with
      // warnings today).
      if (outcome.status === 'waiting' && outcome.warnings?.length) {
        pending.push(
          prisma.flowRunStep
            .updateMany({
              where: { flowRunId: run.id, nodeId: rowKey, status: 'waiting' },
              data: { warnings: jsonValue(outcome.warnings) },
            })
            .catch(() => undefined),
        )
      }
      return
    }
    pending.push(
      prisma.flowRunStep
        .create({
          data: {
            flowRunId: run.id,
            nodeId: rowKey,
            order: order++,
            status: outcome.status,
            // The resolved input the node evaluated (see StepOutcome.input) —
            // `{}` only for outcomes that genuinely carry none (skips, stop).
            input: jsonValue(outcome.input ?? {}),
            output: jsonValue(outcome.output ?? null),
            error: outcome.error ? truncateWithMarker(outcome.error, 300) : null,
            ...(outcome.warnings?.length ? { warnings: jsonValue(outcome.warnings) } : {}),
            // Pin/override provenance for a node the interpreter never
            // actually ran (see interpret.ts's completedProvenance). Never
            // `warnings` — a pin/override substitution must not flip a clean
            // run `degraded`.
            ...(outcome.logs?.length ? { logs: jsonValue(outcome.logs) } : {}),
            startedAt: outcome.startedAt,
            finishedAt: outcome.finishedAt,
          },
        })
        .catch(() => undefined),
    )
  }

  // Adapter: each agent node runs the real agent and records a FlowRunStep row.
  const runAgent: RunAgentFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: node.id,
        order: order++,
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
  const runActionStep: RunActionFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: node.id,
        order: order++,
        status: 'running',
        // Persisted request details must never contain credentials: an http
        // step's Authorization header value is replaced with 'redacted'. A
        // code step's context.steps (a full copy of every prior step's
        // output) is replaced with a marker — each of those outputs already
        // lives on its own row, and duplicating them made rows quadratic.
        input: jsonValue(
          node.kind === 'http'
            ? redactHttpStepInput(node.config)
            : node.kind === 'code'
              ? persistedCodeStepInput(node.config)
              : node.config,
        ),
        startedAt: new Date(),
      },
    })
    // Conditional on 'running' for the same reason as agent steps: the
    // end-of-run failure sweep is authoritative over any late adapter write.
    const finish = async (patch: {
      status: string
      output?: unknown
      error?: string
      logs?: string[]
      warnings?: string[]
    }) => {
      await prisma.flowRunStep.updateMany({
        where: { id: step.id, status: 'running' },
        data: {
          status: patch.status,
          output: patch.output !== undefined ? jsonValue(patch.output) : undefined,
          error: patch.error ? truncateWithMarker(patch.error, 300) : undefined,
          logs: patch.logs && patch.logs.length ? jsonValue(patch.logs) : undefined,
          // Degraded-success notes (e.g. a ledger replay): without this the
          // replay would be invisible in the run panel and the step would read
          // as a fresh call that never happened.
          warnings: patch.warnings && patch.warnings.length ? jsonValue(patch.warnings) : undefined,
          finishedAt: new Date(),
        },
      })
    }
    try {
      if (node.kind === 'tool') {
        // Tool steps route by connection-id prefix to the right tool plane
        // (People.ai / MCP / native / Nango) — the same planes and
        // executors the agent runtime uses. See @/lib/flows/tool-connection-id.
        const connectionId = String(node.config.connectionId || '')
        const { plane, ref } = parseFlowToolConnectionId(connectionId)
        const toolName = String(node.config.toolName)

        // Re-entering a step paused on an approval: the reply carries the
        // decision (decideApproval already executed an approved write, exactly
        // as it does for agent runs) — consume it, never re-execute the write.
        // PER-ITERATION correlated consume: this exact node (`${id}#${index}`
        // inside a loop) consumes ONLY the decision naming the approval IT
        // paused on. Another loop iteration's decision falls through here and
        // re-queues that iteration's own approval below. Each approval id is
        // unique, so it is consumed by exactly one iteration.
        const ownApprovalId = pausedApprovalByNode.get(node.id)
        if (ownApprovalId && typeof job.reply === 'string') {
          const decision = parseApprovalDecision(job.reply)
          if (decision && shouldConsumeApprovalDecision(decision, ownApprovalId)) {
            if (decision.status === 'approved') {
              const output = decision.result ?? { status: 'approved', executed: decision.executed === true }
              await finish({ status: 'succeeded', output })
              return { output }
            }
            const message = 'The approver rejected this action.'
            await finish({ status: 'failed', error: message })
            return { error: message }
          }
        }

        // Slack thread-binding (Task 9): a run triggered by a Slack message
        // defaults an unset `thread_ts` on a slack_post_message step to that
        // message's thread — see applySlackThreadDefault's doc comment. An
        // explicit `thread_ts` on the step always wins.
        const args = applySlackThreadDefault(toolName, prepareToolArgs(node.config.args), run.trigger)
        const executor = await resolveFlowToolExecutor({
          organizationId: job.organizationId,
          userId: job.userId,
          plane,
          ref,
          toolName,
        })

        // Flow steps never pause on approvals: a flow is expected to run end to
        // end, so delivery-plane writes execute inline like every other tool
        // call (every write is still audited below). Agents keep their own
        // opt-in `requireApproval` gate — that's an agent-runtime concern. The
        // decision-consume block above stays so runs paused on an approval
        // BEFORE this change still resume cleanly.
        const retries = flowActionRetries(node.config.retries)
        const retryDelayMs = typeof node.config.retryDelayMs === 'number' ? node.config.retryDelayMs : undefined
        const timeoutMs = flowActionTimeoutMs(node.config.timeoutMs)
        // retryOnTimeout=false: a timed-out tool call is only abandoned, not
        // cancelled — the write may still land, so retrying could execute the
        // side effect twice. Hard errors keep the retry budget. (HTTP steps
        // below abort the request on timeout, so they may retry.)
        // Replay guard. A retry, a resumed run, or a re-emitted poll item can
        // reach this line for a write that ALREADY landed at the provider —
        // idempotency headers never covered tool planes (one HTTP call site,
        // and most Nango/MCP providers ignore an unknown header anyway). The
        // ledger is what makes that a local no-op.
        const ledgerKey = { scopeKey, iterationKey: node.id, page: 0 }
        const recorded = await readLedger({ ...ledgerKey, organizationId: job.organizationId })
        if (recorded) {
          // Say so rather than pretending the call happened again — no audit
          // entry either, since no tool call occurred.
          await finish({ status: 'succeeded', output: recorded.result, warnings: [LEDGER_REPLAY_WARNING] })
          return { output: recorded.result }
        }

        // Same deterministic gate as the agent runtime: flow tool args are
        // template-resolved from step data, which includes third-party content
        // — the same channel a jailbreak would use to smuggle a credential out.
        const verdict = inspectToolArgs(args)
        if (!verdict.allowed) {
          const blockedMessage = blockedCallMessage(toolName, verdict)
          await recordToolCallGuardEvent({
            organizationId: job.organizationId,
            executionId: run.id,
            actorUserId: job.userId,
            kind: 'blocked_args',
            toolName,
            reasons: verdict.reasons,
          })
          throw new Error(blockedMessage)
        }

        const { result: output, attempts: toolAttempts, attemptErrors: toolAttemptErrors } = await runWithRetries(
          async () => flowToolOutput(await executor.execute(toolName, args)),
          {
            retries,
            retryDelayMs,
            timeoutMs,
            retryOnTimeout: shouldRetryAfterTimeout('tool'),
            timeoutMessage: timeoutMs
              ? `Tool ${toolName} timed out after ${Math.round(timeoutMs / 1000)}s — the call may still be finishing in the background.`
              : undefined,
          },
        )

        await writeLedger({
          ...ledgerKey,
          organizationId: job.organizationId,
          provider: executor.provider,
          tool: toolName,
          result: output,
          flowRunId: run.id,
        })
        // Immutable audit trail, mirroring the agent loop's tool execution:
        // every plane is recorded; write/delivery planes are the consequential
        // ones. Args are hashed by recordAudit, never stored raw.
        await recordAudit({
          organizationId: job.organizationId,
          executionId: run.id,
          actorUserId: job.userId,
          actorKind: 'agent',
          action: WRITE_PLANES.test(executor.provider) ? 'tool.write' : 'tool.call',
          tool: toolName,
          resourceType: executor.provider,
          payload: args,
        })
        const toolWarnings = retryWarnings(toolAttempts, toolAttemptErrors)
        await finish({ status: 'succeeded', output, ...(toolWarnings.length ? { warnings: toolWarnings } : {}) })
        return { output }
      }
      if (node.kind === 'ai') {
        // Single-turn model call (WS14): the interpreter already resolved
        // input/instructions against the flow context (see interpret.ts's
        // 'ai' branch); every other field here (aiOp, model, categories,
        // outputFields, score bounds) is a static read as-is off the config,
        // same as tool/http's retries/timeoutMs.
        const aiData = node.config as AiPromptInput
        // The workspace AI opt-out, enforced before the prompt is built. Same
        // gate as the agent runtime, surfaced the flow way: a refused step is a
        // failed step carrying the policy sentence, not a thrown run — the rest
        // of the flow's error handling (retry policy, error branch) then applies
        // to it exactly as it would to any other step that could not run.
        const egressRefusal = await aiEgressRefusal({
          organizationId: job.organizationId,
          userId: job.userId,
          surface: 'flow.ai_step',
          resourceType: 'flow_run_step',
          resourceId: run.id,
        })
        if (egressRefusal) {
          await finish({ status: 'failed', error: egressRefusal.message })
          return { error: egressRefusal.message }
        }
        const prompt = buildAiPrompt(aiData)
        const model = aiData.model === 'smart' ? DEFAULT_AGENT_MODEL : DEFAULT_SUMMARY_MODEL
        // Same record as the agent path: the resolved input is tenant data on
        // its way to a model provider.
        trackDetached(recordPiiEgress({ organizationId: job.organizationId, userId: job.userId, surface: 'flow.ai_step', text: prompt.user }))
        // Same daily model ceilings as the agent plane, applied to the run's
        // owner. A spent allowance moves the step to Qwen rather than failing
        // it. See usage/model-allowance.ts.
        const runner = createModelRunner(model, await modelAllowanceFor(run.userId))
        // Surfaced as a step warning, the same channel a ledger replay uses:
        // a step that quietly ran on a different model than the flow asks for
        // reads as the model misbehaving rather than as a policy.
        const modelWarnings = [downgradeNotice(model, runner.model)].filter((note): note is string => Boolean(note))
        // Structured ops (extract/categorize/score) get the JSON-contract
        // instruction appended to the user message before the call — same
        // idiom as the 'agent' node's structured branch in interpret.ts.
        const user = prompt.structuredFields
          ? `${prompt.user}\n\n${structuredResponseInstruction(prompt.structuredFields)}`
          : prompt.user

        const retries = flowActionRetries(node.config.retries)
        const retryDelayMs = typeof node.config.retryDelayMs === 'number' ? node.config.retryDelayMs : undefined
        const timeoutMs = flowActionTimeoutMs(node.config.timeoutMs)
        // retryOnTimeout=false: same reasoning as the tool path above — a
        // timed-out model call is only abandoned, not cancelled, so retrying
        // could run it a second time concurrently (double token spend). Hard
        // errors keep the retry budget.
        // Wall-clock only — no extra call, so this costs nothing on the user
        // path. Feeds the shadow row below so champion latency is comparable
        // to the challenger's (which times its own call the same way).
        const championStartedAt = Date.now()
        const { result: turn, attempts: aiAttempts, attemptErrors: aiAttemptErrors } = await runWithRetries(
          async () =>
            runner.next(
              runner.start(user),
              prompt.system,
              [],
              // 'flow_ai' — a standalone AI step, not the agent runtime's own
              // turns (which record as 'agent_turn') — so per-surface cost
              // breakdowns don't conflate the two very different call shapes.
              // Carries flowRunStepId too, so a per-step cost breakdown is
              // possible (see @/lib/flows/ai-step-ledger).
              buildFlowAiLedgerContext({
                organizationId: job.organizationId,
                userId: run.userId,
                flowRunId: run.id,
                flowRunStepId: step.id,
              }),
            ),
          {
            retries,
            retryDelayMs,
            timeoutMs,
            retryOnTimeout: shouldRetryAfterTimeout('ai'),
            timeoutMessage: timeoutMs
              ? `AI step timed out after ${Math.round(timeoutMs / 1000)}s — the call may still be finishing in the background.`
              : undefined,
          },
        )
        // Meter the AI step against the workspace monthly ceiling. Agent steps
        // record their own spend inside runAgentExecution; a bare 'ai' step calls
        // the model directly, so without this a loop of ai steps would spend
        // unmetered and never trip the ceiling.
        trackDetached(
          recordTokenUsage(
            job.organizationId,
            turn.usage ? billableTokens(turn.usage) : 0,
          ),
        )

        // Sampled challenger comparison (off unless SHADOW_EVAL_RATE is set).
        // This is the only run surface shadowed, because it is the only one
        // with no side effects to double-fire — see lib/eval/shadow.ts. Fire
        // and forget: never awaited, never able to fail the step.
        trackDetached(
          maybeShadowFlowAiStep({
            organizationId: job.organizationId,
            userId: run.userId,
            flowRunId: run.id,
            system: prompt.system,
            user,
            championText: turn.text,
            championProvider: turn.provider,
            championModel: turn.servedModel,
            championUsage: turn.usage,
            championLatencyMs: Date.now() - championStartedAt,
          }),
        )

        const aiRetryWarnings = retryWarnings(aiAttempts, aiAttemptErrors)
        if (!prompt.structuredFields) {
          await finish({ status: 'succeeded', output: turn.text, warnings: [...modelWarnings, ...aiRetryWarnings] })
          return { output: turn.text }
        }
        // Structured ops never throw on a malformed/invalid reply — parse and
        // postValidate failures resolve the step as a normal failed output,
        // exactly like a rejected approval above.
        const parsed = parseStructuredAgentOutput(turn.text, prompt.structuredFields)
        if (parsed.error) {
          await finish({ status: 'failed', error: parsed.error, ...(aiRetryWarnings.length ? { warnings: aiRetryWarnings } : {}) })
          return { error: parsed.error }
        }
        const validationError = prompt.postValidate(parsed.output ?? {})
        if (validationError) {
          await finish({ status: 'failed', error: validationError, ...(aiRetryWarnings.length ? { warnings: aiRetryWarnings } : {}) })
          return { error: validationError }
        }
        await finish({ status: 'succeeded', output: parsed.output, warnings: [...modelWarnings, ...aiRetryWarnings] })
        return { output: parsed.output }
      }
      if (node.kind === 'subflow') {
        // Run another flow inline as this step (WS15). Guards are pure
        // (subflowGuard); the child always executes its PUBLISHED graph — a
        // draft-only child is a clear config error, matching the "runs the
        // published version" contract everywhere else. Depth is carried on the
        // job so indirect cycles (A→B→A) exhaust the cap instead of looping.
        const childFlowId = typeof node.config.flowId === 'string' ? node.config.flowId : ''
        const guardError = subflowGuard({ flowId: childFlowId, selfFlowId: job.flowId, depth: job.subflowDepth ?? 0 })
        if (guardError) {
          await finish({ status: 'failed', error: guardError })
          return { error: guardError }
        }
        const child = await prisma.flow.findFirst({ where: { id: childFlowId, organizationId: job.organizationId } })
        if (!child) {
          const error = 'The selected flow no longer exists in this workspace.'
          await finish({ status: 'failed', error })
          return { error }
        }
        if (child.publishedGraph == null) {
          const error = `"${child.name}" has never been published — publish it before running it from another flow.`
          await finish({ status: 'failed', error })
          return { error }
        }
        // Parent resume: the user's reply answers the CHILD's pause — forward
        // it into the paused child run (no retries: a lost race with the
        // child's own resume machinery must surface, not re-run the child).
        const pausedChildRunId = node.resume ? pausedSubflowRunByNode.get(node.id) : undefined
        if (pausedChildRunId) {
          try {
            const resumed = await runFlowExecution({
              flowId: child.id,
              organizationId: job.organizationId,
              userId: job.userId,
              flowRunId: pausedChildRunId,
              reply: job.reply ?? '',
              usePublished: true,
              subflowDepth: (job.subflowDepth ?? 0) + 1,
            })
            if (resumed.status === 'waiting') {
              const question = await subflowChildQuestion(pausedChildRunId, child.name)
              await finish({ status: 'waiting', output: { waiting: { kind: 'input', question, childRunId: pausedChildRunId, childFlowId: child.id } } })
              return { waiting: { status: 'waiting_for_input', question } }
            }
            if (resumed.status !== 'succeeded') {
              const error = `"${child.name}" failed after your reply — open its run in Activity to see why.`
              await finish({ status: 'failed', error })
              return { error }
            }
            await finish({ status: 'succeeded', output: resumed.output })
            return { output: resumed.output }
          } catch (error) {
            const message = error instanceof ApiError && error.code === 'FLOW_RUN_NOT_WAITING'
              ? `"${child.name}" is no longer waiting — it may have been answered from its own activity page.`
              : error instanceof Error ? error.message : String(error)
            await finish({ status: 'failed', error: message })
            return { error: message }
          }
        }
        const childInput = subflowChildInput(
          node.config.inputs as Record<string, string> | undefined,
          typeof node.config.input === 'string' ? node.config.input : undefined,
        )
        const retries = flowActionRetries(node.config.retries)
        const retryDelayMs = typeof node.config.retryDelayMs === 'number' ? node.config.retryDelayMs : undefined
        // Child flows legitimately run long — clamp to the platform run cap,
        // not the 120s tool/http window; unset means "no extra bound" (the
        // child is already bounded by its own execution limits).
        const timeoutMs =
          typeof node.config.timeoutMs === 'number' && Number.isFinite(node.config.timeoutMs)
            ? Math.max(1000, Math.min(AGENT_RUN_TIMEOUT_MS, Math.round(node.config.timeoutMs)))
            : undefined
        // Fire-and-forget: start the child and move on (n8n's "Wait For
        // Sub-Workflow Completion", off). The child gets its own run row and
        // its own keep-alive, so it survives this step returning; the parent
        // records that it was started rather than pretending to have a result.
        if (node.config.waitForCompletion === false) {
          await dispatchDetachedFlowExecution({
            flowId: child.id,
            organizationId: job.organizationId,
            userId: job.userId,
            input: childInput,
            usePublished: true,
            trigger: { type: 'subflow', parentRunId: run.id, parentFlowId: job.flowId },
            subflowDepth: (job.subflowDepth ?? 0) + 1,
          })
          const output = { started: true, flowId: child.id, flowName: child.name }
          await finish({ status: 'succeeded', output })
          return { output }
        }
        const { result, attempts: subflowAttempts, attemptErrors: subflowAttemptErrors } = await runWithRetries(
          async () =>
            runFlowExecution({
              flowId: child.id,
              organizationId: job.organizationId,
              userId: job.userId,
              input: childInput,
              usePublished: true,
              trigger: { type: 'subflow', parentRunId: run.id, parentFlowId: job.flowId },
              subflowDepth: (job.subflowDepth ?? 0) + 1,
            }),
          {
            retries,
            retryDelayMs,
            timeoutMs,
            retryOnTimeout: shouldRetryAfterTimeout('subflow'),
            timeoutMessage: timeoutMs
              ? `"${child.name}" timed out after ${Math.round(timeoutMs / 1000)}s — its run may still be finishing.`
              : undefined,
          },
        )
        const subflowRetryWarnings = retryWarnings(subflowAttempts, subflowAttemptErrors)
        if (result.status === 'waiting') {
          // The child paused — suspend the PARENT too. The waiting row carries
          // the child run id so a reply to the parent resumes the child.
          const question = await subflowChildQuestion(result.flowRunId, child.name)
          await finish({
            status: 'waiting',
            output: { waiting: { kind: 'input', question, childRunId: result.flowRunId, childFlowId: child.id } },
            ...(subflowRetryWarnings.length ? { warnings: subflowRetryWarnings } : {}),
          })
          return { waiting: { status: 'waiting_for_input', question } }
        }
        if (result.status !== 'succeeded') {
          const error = `"${child.name}" failed — open its latest run in Activity to see why.`
          await finish({ status: 'failed', error, ...(subflowRetryWarnings.length ? { warnings: subflowRetryWarnings } : {}) })
          return { error }
        }
        await finish({ status: 'succeeded', output: result.output, ...(subflowRetryWarnings.length ? { warnings: subflowRetryWarnings } : {}) })
        return { output: result.output }
      }
      if (node.kind === 'knowledge') {
        // Org-shared knowledge only: agentId '' matches no agent-owned chunks,
        // so the `agentId IS NULL` branch (workspace documents) is what's
        // searched. Best-effort by contract — empty query or no hits is a
        // successful empty list, never a failure.
        const query = typeof node.config.query === 'string' ? node.config.query.trim() : ''
        if (!query) {
          await finish({ status: 'succeeded', output: [] })
          return { output: [] }
        }
        const k = typeof node.config.topK === 'number' && Number.isFinite(node.config.topK)
          ? Math.max(1, Math.min(20, Math.round(node.config.topK)))
          : undefined
        const hits = await retrieveKnowledge({ organizationId: job.organizationId, agentId: '', query, k })
        await finish({ status: 'succeeded', output: hits })
        return { output: hits }
      }
      if (node.kind === 'code') {
        const language = node.config.language === 'python' ? 'python' : 'javascript'
        const mode = node.config.mode === 'each' ? 'each' : 'all'
        const { output, logs } = await runFlowCode({
          language,
          mode,
          code: typeof node.config.code === 'string' ? node.config.code : '',
          input: node.config.input,
          context: node.config.context && typeof node.config.context === 'object' && !Array.isArray(node.config.context)
            ? node.config.context as Record<string, unknown>
            : {},
          timeoutMs: typeof node.config.timeoutMs === 'number' ? node.config.timeoutMs : undefined,
        })
        await finish({ status: 'succeeded', output, logs })
        return { output }
      }
      if (node.kind === 'http') {
        const request = prepareHttpRequest(node.config)
        const requestForAttempt = (url: string, page = 0) => ({
          ...request,
          url,
          init: {
            ...request.init,
            headers: withIdempotencyHeader(
              request.init.headers as Record<string, string>,
              String(request.init.method || 'GET'),
              // Scoped, not run-keyed: a poll run keys by the polled item so a
              // re-emitted item produces the same header as the first attempt.
              flowSideEffectKey(scopeKey, node.id, page),
            ),
          },
        })
        // Safe methods have nothing to record or replay — withIdempotencyHeader
        // already skips them, and a read has no side effect.
        const httpMethod = String(request.init.method || 'GET').toUpperCase()
        const isSafeMethod = httpMethod === 'GET' || httpMethod === 'HEAD' || httpMethod === 'OPTIONS'
        // Collected across pages: a partially-replayed paginated request should
        // say so once, not per page.
        const replayWarnings: string[] = []
        let httpCredential: ResolvedHttpCredential | null = null
        const credentialId = typeof node.config.credentialId === 'string' ? node.config.credentialId.trim() : ''
        if (credentialId) {
          httpCredential = await resolveHttpCredential(credentialId, job.organizationId, {
            actorUserId: job.userId,
            executionId: run.id,
            consumer: 'flow.http_step',
          })
        }
        // Optional connection auth: resolve a fresh token server-side and inject
        // it as the Authorization header — unless the user set their own, which
        // wins. The token lives only in the outbound request, never in the
        // persisted step input/output or logs.
        const httpConnectionId = typeof node.config.connectionId === 'string' ? node.config.connectionId.trim() : ''
        if (!httpCredential && httpConnectionId) {
          const token = await resolveHttpConnectionToken({
            connectionId: httpConnectionId,
            organizationId: job.organizationId,
            userId: job.userId,
          })
          request.init.headers = withBearerAuthorization(request.init.headers as Record<string, string>, token)
        }

        // File UPLOAD: a form-data field whose value is a file reference is sent
        // as the actual file. prepareHttpRequest built a text-only FormData
        // (pure, no DB); here we read each referenced StoredFile's bytes and
        // rebuild the body with real Blobs, dropping the content-type so the
        // runtime sets the multipart boundary itself.
        //
        // buildMultipartBody THROWS when a referenced file can no longer be
        // read; that propagates to this adapter's catch and fails the step with
        // the reader's own message. Dropping the part instead (what the old
        // inline loop did) posted the request without its attachment and
        // reported success — a silent partial upload.
        if (node.config.bodyMode === 'form-data' && node.config.sendBody !== false && bodyHasFileReference(node.config.body)) {
          request.init.body = await buildMultipartBody(node.config.body, (fileId) => readStoredFile(fileId, job.organizationId))
          const headers = request.init.headers as Record<string, string>
          for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key]
        }

        const retries = flowActionRetries(node.config.retries)
        const retryDelayMs = typeof node.config.retryDelayMs === 'number' ? node.config.retryDelayMs : undefined

        // responseType 'file': download the body to a StoredFile and output a
        // file reference (with extracted text when the type supports it), rather
        // than parsing the body. Files flow onward as references, not bytes.
        if (node.config.responseType === 'file') {
          const { result: output, attempts: fileAttempts, attemptErrors: fileAttemptErrors } = await runWithRetries(async () => {
            await assertPublicUrl(request.url)
            const controller = new AbortController()
            let timedOut = false
            const timer = setTimeout(() => {
              timedOut = true
              controller.abort()
            }, request.timeoutMs)
            try {
              const response = await fetchWithHttpCredential(requestForAttempt(request.url), httpCredential, controller.signal)
              if (httpCredential?.id) {
                const authRejected = response.status === 401 || response.status === 403
                await markCredentialResult(httpCredential.id, job.organizationId, !authRejected, `HTTP ${response.status}`)
              }
              if (request.failOnHttpError && !response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`)
              const buffer = Buffer.from(await readResponseBytesLimited(response, STORED_FILE_MAX_BYTES, 'Downloaded file'))
              const mimeType = (response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim()
              const filename = httpDownloadFilename(response.headers.get('content-disposition'), request.url)
              const saved = await saveStoredFile({ organizationId: job.organizationId, userId: job.userId, filename, mimeType, buffer })
              let content: string | undefined
              if (isSupported(saved.mimeType, filename)) {
                // Downloads DEGRADE, ingestion REJECTS: knowledge ingestion
                // fails loudly on a file it cannot read (a partial document is
                // worse than none), but this step's job is to fetch and store
                // the bytes — which succeeded. A corrupt or password-protected
                // DOCX/PDF therefore yields empty text instead of failing the
                // step. Same treatment as the /api/files upload route.
                content = truncateWithMarker(await extractTextAuto(buffer, saved.mimeType, filename).catch(() => ''), 200_000)
              }
              return fileReference(saved, { content }) as unknown as Record<string, unknown>
            } catch (error) {
              if (timedOut) throw new Error(`HTTP request timed out after ${request.timeoutMs}ms`)
              throw error
            } finally {
              clearTimeout(timer)
            }
          }, { retries, retryDelayMs })
          const fileRetryWarnings = retryWarnings(fileAttempts, fileAttemptErrors)
          await finish({ status: 'succeeded', output, ...(fileRetryWarnings.length ? { warnings: fileRetryWarnings } : {}) })
          return { output }
        }

        // Fetch ONE page (URL overridable for pagination), retried per page. The
        // SSRF guard re-runs before every attempt AND every page.
        //
        // Ledger-guarded for unsafe methods: the idempotency header only helps
        // with providers that honor it, so a replayed POST is made a local
        // no-op here regardless. Each PAGE is its own side effect.
        const fetchPage = async (pageUrl: string, page = 0): Promise<FlowHttpOutput> => {
          const ledgerKey = { scopeKey, iterationKey: node.id, page }
          if (!isSafeMethod) {
            const recorded = await readLedger({ ...ledgerKey, organizationId: job.organizationId })
            if (recorded) {
              if (!replayWarnings.length) replayWarnings.push(LEDGER_REPLAY_WARNING)
              return recorded.result as FlowHttpOutput
            }
          }
          const fetched = await fetchOnePage(pageUrl, page)
          // Only a SETTLED result is recorded. A retryable status (429/5xx) that
          // exhausted its budget must NOT be recorded — the ledger would replay
          // that failure forever on every later attempt. A terminal 404 is a
          // settled answer and is worth recording.
          if (!isSafeMethod && classifyRetry(null, fetched.status) !== 'retryable') {
            await writeLedger({
              ...ledgerKey,
              organizationId: job.organizationId,
              provider: 'http',
              tool: node.id,
              result: fetched,
              flowRunId: run.id,
            })
          }
          return fetched
        }

        // runHttpWithRetries, not runWithRetries: a non-2xx response is a VALUE
        // here, so a 429/503 never reached the retry loop at all. It converts a
        // retryable status into a throw internally and back into the response
        // when the budget runs out — retries=0 stays byte-identical.
        const fetchOnePage = (pageUrl: string, page = 0): Promise<FlowHttpOutput> =>
          runHttpWithRetries(async () => {
            await assertPublicUrl(pageUrl)
            const controller = new AbortController()
            let timedOut = false
            const timer = setTimeout(() => {
              timedOut = true
              controller.abort()
            }, request.timeoutMs)
            try {
              const response = await fetchWithHttpCredential(requestForAttempt(pageUrl, page), httpCredential, controller.signal)
              const nextOutput = await responseOutput(response, request.responseType, HTTP_MAX_RESPONSE_CHARS)
              // Record credential health so the picker can flag a revoked token
              // instead of failing silently. Auth rejection flips it to 'error';
              // any non-auth response clears a prior error.
              if (httpCredential?.id) {
                const authRejected = nextOutput.status === 401 || nextOutput.status === 403
                await markCredentialResult(httpCredential.id, job.organizationId, !authRejected, `HTTP ${nextOutput.status}`)
              }
              if (request.failOnHttpError && !nextOutput.ok) throw new Error(`HTTP ${nextOutput.status}: ${nextOutput.bodyText.slice(0, 200)}`)
              return nextOutput
            } catch (error) {
              if (timedOut) throw new Error(`HTTP request timed out after ${request.timeoutMs}ms`)
              throw error
            } finally {
              clearTimeout(timer)
            }
          }, { retries, retryDelayMs })

        const pagination = node.config.pagination && typeof node.config.pagination === 'object' ? (node.config.pagination as Record<string, unknown>) : undefined
        let output: FlowHttpOutput
        if (pagination) {
          const maxPages = Math.max(1, Math.min(50, typeof pagination.maxPages === 'number' ? pagination.maxPages : 5))
          const intervalMs = Math.max(0, Math.min(10_000, typeof pagination.intervalMs === 'number' ? pagination.intervalMs : 0))
          const itemsPath = typeof pagination.itemsPath === 'string' ? pagination.itemsPath : undefined
          const completeWhen = typeof pagination.completeWhen === 'string' ? pagination.completeWhen : 'emptyPage'
          const collected: unknown[] = []
          let last: FlowHttpOutput | undefined
          let pageUrl = request.url
          let pages = 0
          for (let i = 0; i < maxPages; i++) {
            if (pagination.mode === 'updateParam' && typeof pagination.param === 'string' && pagination.param) {
              const start = typeof pagination.start === 'number' ? pagination.start : 1
              const step = typeof pagination.step === 'number' ? pagination.step : 1
              pageUrl = setQueryParam(request.url, pagination.param, start + i * step)
            }
            last = await fetchPage(pageUrl, i)
            pages += 1
            // Stop-condition FIRST, so a terminal page (a 404 past the end, a
            // has_more that flipped false) neither contributes items nor costs
            // another request. Without it the only stops were maxPages and an
            // empty page, which walks past the end of any API that signals
            // completion some other way.
            if (paginationComplete(pagination, last)) break
            const items = pageItems(last.body, itemsPath)
            collected.push(...items)
            if (pagination.mode === 'nextUrl') {
              const next = getByPath(last.body, typeof pagination.nextUrlPath === 'string' ? pagination.nextUrlPath : undefined)
              if (typeof next !== 'string' || !next) break
              pageUrl = next
            } else if (items.length === 0 && completeWhen === 'emptyPage') {
              break // updateParam: an empty page means we're past the end
            }
            if (intervalMs && i < maxPages - 1) await new Promise((r) => setTimeout(r, intervalMs))
          }
          // The envelope of the last page, but body is every page's items combined.
          output = { ...(last as FlowHttpOutput), body: collected }
          ;(output as unknown as Record<string, unknown>).pages = pages
        } else {
          output = await fetchPage(request.url)
        }

        // "Optimize response for AI": trim the (possibly combined) body.
        const optimize = node.config.optimizeForAi && typeof node.config.optimizeForAi === 'object' ? (node.config.optimizeForAi as Record<string, unknown>) : undefined
        if (optimize) {
          output = {
            ...output,
            body: optimizeForAi(output.body, {
              dataPath: typeof optimize.dataPath === 'string' ? optimize.dataPath : undefined,
              fields: Array.isArray(optimize.fields) ? optimize.fields.filter((f): f is string => typeof f === 'string') : undefined,
              maxItems: typeof optimize.maxItems === 'number' ? optimize.maxItems : undefined,
            }),
          }
        }
        await finish({
          status: 'succeeded',
          output,
          ...(replayWarnings.length ? { warnings: replayWarnings } : {}),
        })
        return { output }
      }
      // Exhaustive over RunActionFn's node.kind — this
      // only fires if a future kind is added here without a matching branch
      // above, so it fails loudly instead of silently misrouting into http
      // (the bug this restructure closed for 'ai').
      throw new Error('Unsupported flow action kind')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A retry budget exhausted by runWithRetries attaches its full attempt
      // trail to the thrown error (see RetryEvidenceError) — surface it as
      // step warnings so every failed attempt stays visible, not only the
      // last one that lands in `error`. Gated on attempts > 1 (retryWarnings)
      // so a retries:0 failure (one attempt, one attemptErrors entry) does
      // not duplicate `error` verbatim as a "warning".
      const evidence = error instanceof Error ? (error as RetryEvidenceError) : undefined
      const attemptWarnings = evidence?.attemptErrors ? retryWarnings(evidence.attempts ?? 0, evidence.attemptErrors) : []
      await finish({ status: 'failed', error: message, ...(attemptWarnings.length ? { warnings: attemptWarnings } : {}) })
      return { error: message }
    }
  }

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
  const isCancelled = async (): Promise<boolean> => {
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
    result = await interpretFlow(graph, input, {
      runAgent,
      runAction,
      onStep,
      now,
      run: runMeta,
      isCancelled,
      // Display labels (agent titles included) so hand-typed friendly-label
      // tokens like {{Previous Agent.output}} resolve to the right step.
      stepLabels: stepLabelsOf(graph, orgAgents),
      ...(resuming || replaySource || Object.keys(completed).length ? { completed, completedRoutes } : {}),
      ...(Object.keys(completedProvenance).length ? { completedProvenance } : {}),
      ...(resuming ? { resumeNodeId, resumeReply: job.reply } : {}),
      ...(job.stopAfterNodeId ? { stopAfterNodeId: job.stopAfterNodeId } : {}),
      ...(job.stopBeforeNodeId ? { stopBeforeNodeId: job.stopBeforeNodeId } : {}),
    })
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

  return { flowRunId: run.id, status, output: effectiveOutput }
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
  await queue.add('execute-flow', job, flowJobOptions(job.flowRunId, undefined, job.deliveryId))
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
    await queue.add('execute-flow', job, flowJobOptions(job.flowRunId, job.preparedRunId, job.deliveryId))
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
  return runFlowExecution(job.data)
}
