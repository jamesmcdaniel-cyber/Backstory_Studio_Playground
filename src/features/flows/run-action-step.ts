import { prisma } from '@/lib/prisma'
import { classifyRetry, flowActionRetries, flowActionTimeoutMs, runWithRetries, shouldRetryAfterTimeout, type RetryEvidenceError } from './action-reliability'
import { parseStructuredAgentOutput, structuredResponseInstruction } from './agent-response'
import { runFlowCode } from './code-runner'
import { prepareHttpRequest, redactHttpStepInput, responseOutput, withBearerAuthorization, type FlowHttpOutput } from './http'
import {
  fetchWithHttpCredential,
  markCredentialResult,
  resolveHttpConnectionToken,
  resolveHttpCredential,
  type ResolvedHttpCredential,
} from './http-auth'
import { runHttpWithRetries } from './http-retry'
import {
  HTTP_MAX_RESPONSE_CHARS,
  httpDownloadFilename,
  jsonValue,
  persistedCodeStepInput,
  retryWarnings,
  subflowChildQuestion,
} from './run-step-persistence'
import { applySlackChainDepthMetadata, applySlackThreadDefault, prepareToolArgs } from './tool-args'
import { flowToolOutput } from './tool-output'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { AGENT_RUN_TIMEOUT_MS } from '@/lib/agents/timeouts'
import { recordAudit, toolAuditAction } from '@/lib/audit'
import { resolveCredentialResolver } from '@/lib/credentials/resolver'
import { maybeShadowFlowAiStep } from '@/lib/eval/shadow'
import { STORED_FILE_MAX_BYTES, readStoredFile, saveStoredFile } from '@/lib/files/storage'
import { buildAiPrompt, type AiPromptInput } from '@/lib/flows/ai-prompts'
import { buildFlowAiLedgerContext } from '@/lib/flows/ai-step-ledger'
import { parseApprovalDecision, shouldConsumeApprovalDecision } from '@/lib/flows/approval-decision'
import { bodyHasFileReference, buildMultipartBody, fileReference } from '@/lib/flows/file-ref'
import { getByPath, optimizeForAi, pageItems, paginationComplete, setQueryParam } from '@/lib/flows/http-pagination'
import { flowSideEffectKey, withIdempotencyHeader } from '@/lib/flows/idempotency'
import { trackDetached } from '@/lib/flows/keep-alive'
import { parseFlowSettings, subflowCallerAllowed } from '@/lib/flows/settings'
import { LEDGER_REPLAY_WARNING, readLedger, writeLedger } from '@/lib/flows/side-effect-ledger'
import { subflowChildInput, subflowGuard } from '@/lib/flows/subflow'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { truncateWithMarker } from '@/lib/flows/truncate'
import { extractTextAuto, isSupported } from '@/lib/knowledge/extract'
import { retrieveKnowledge } from '@/lib/knowledge/retrieve'
import { DEFAULT_AGENT_MODEL, DEFAULT_SUMMARY_MODEL, billableTokens, createModelRunner } from '@/lib/llm/model-runner'
import { readResponseBytesLimited } from '@/lib/net/response-body'
import { assertPublicUrl } from '@/lib/net/ssrf'
import { blockedCallMessage, inspectToolArgs, recordToolCallGuardEvent } from '@/lib/security/tool-call-guard'
import { ApiError } from '@/lib/server/api-handler'
import { aiEgressRefusal, recordPiiEgress } from '@/lib/usage/ai-guard'
import { recordTokenUsage } from '@/lib/usage/budget'
import { modelAllowanceFor } from '@/lib/usage/model-allowance'
import { downgradeNotice } from '@/lib/usage/model-tiers'
import type { FlowExecutionJob } from './execute-flow'
import type { RunActionFn } from './interpret'

/**
 * The action-step executor: everything that happens when the interpreter
 * reaches a node the engine (rather than the interpreter) owns — http, code,
 * tool, ai, approval, subflow, knowledge, wait, and the rest.
 *
 * Carved out of `runFlowExecutionInner`, where it was a 755-line closure inside
 * an 1,819-line function — 78% of execute-flow.ts in a single body with no
 * seam anywhere in it. It closes over only the handful of values in
 * {@link RunActionStepContext}, which is what made the extraction possible and
 * is why that context is passed explicitly rather than reconstructed here: the
 * step counter is shared mutable state with the rest of the run, and the paused
 * maps are seeded by the resume/patch/replay phase before the walk begins.
 */
type FlowRow = NonNullable<Awaited<ReturnType<typeof prisma.flow.findFirst>>>
type FlowRunRow = NonNullable<Awaited<ReturnType<typeof prisma.flowRun.findFirst>>>

export interface RunActionStepContext {
  /** The job being executed — organizationId and userId come from here. */
  job: FlowExecutionJob
  /** The FlowRun row this step belongs to. */
  run: FlowRunRow
  /** The parent flow, for subflow call-permission checks. */
  flow: FlowRow
  /** Idempotency scope for side-effect ledger keys. */
  scopeKey: string
  /**
   * Shared, MUTABLE step ordinal. Container steps written by the interpreter
   * and action steps written here draw from one counter, so the run panel
   * orders them as they actually happened; handing over a copy would restart
   * numbering and interleave the two sources wrongly.
   */
  nextOrder: () => number
  /** Approval ids for nodes this resume is un-pausing, keyed by node id. */
  pausedApprovalByNode: Map<string, string>
  /** Child run ids for subflow nodes this resume is un-pausing. */
  pausedSubflowRunByNode: Map<string, string>
}

/**
 * The one genuine cycle between this module and execute-flow.ts: a SUBFLOW step
 * runs a flow, and running a flow reaches this executor again. Imported
 * dynamically rather than at the top so neither module has to be fully
 * initialised before the other can load — a static cycle here would leave
 * whichever module loaded second holding undefined bindings at call time.
 */
async function flowEngine() {
  return import('./execute-flow')
}

export function createRunActionStep(ctx: RunActionStepContext): RunActionFn {
  const { job, run, flow, scopeKey, pausedApprovalByNode, pausedSubflowRunByNode } = ctx
  const runActionStep: RunActionFn = async (node) => {
    const step = await prisma.flowRunStep.create({
      data: {
        flowRunId: run.id,
        nodeId: node.id,
        order: ctx.nextOrder(),
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
        const args = applySlackChainDepthMetadata(
          toolName,
          applySlackThreadDefault(toolName, prepareToolArgs(node.config.args), run.trigger),
          run.trigger,
        )
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
        // Immutable audit trail, mirroring the agent loop's tool execution.
        // Classified by the tool's own isWrite, not by its plane — see
        // toolAuditAction. Args are hashed by recordAudit, never stored raw.
        await recordAudit({
          organizationId: job.organizationId,
          executionId: run.id,
          actorUserId: job.userId,
          actorKind: 'agent',
          action: toolAuditAction(executor.isWrite),
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
        if (!subflowCallerAllowed(
          parseFlowSettings(child.settings),
          { flowId: flow.id, ownerId: flow.userId },
          { ownerId: child.userId },
        )) {
          const error = `"${child.name}" does not allow calls from this flow.`
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
            const resumed = await (await flowEngine()).runFlowExecution({
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
          await (await flowEngine()).dispatchDetachedFlowExecution({
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
            (await flowEngine()).runFlowExecution({
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
        const credentialResolverId = typeof node.config.credentialResolverId === 'string'
          ? node.config.credentialResolverId.trim()
          : ''
        if (credentialId) {
          httpCredential = await resolveHttpCredential(credentialId, job.organizationId, {
            actorUserId: job.userId,
            executionId: run.id,
            consumer: 'flow.http_step',
          })
        } else if (credentialResolverId) {
          httpCredential = await resolveCredentialResolver(
            credentialResolverId,
            job.organizationId,
            job.userId,
            {
              actorUserId: job.userId,
              executionId: run.id,
              consumer: 'flow.http_step.dynamic',
            },
          )
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

  return runActionStep
}
