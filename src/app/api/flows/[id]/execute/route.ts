import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { dispatchDetachedFlowExecution, startFlowExecution } from '@/features/flows/execute-flow'
import { parseFlowInput } from '@/lib/flows/input'
import { deriveRunWaiting } from '@/lib/flows/run-waiting'
import { rateLimit } from '@/lib/ratelimit'
import { checkMonthlyTokenBudget } from '@/lib/usage/budget'
import { recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'
export const maxDuration = 800

// POST /api/flows/[id]/execute — run a flow manually. id is the path segment
// before "execute".
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  // Throttle interactive runs per org (mirrors the agent-execute limiter) — a
  // flow can contain AI steps and loops, so unbounded concurrent runs are a
  // cost vector. The webhook trigger route has its own per-flow limit.
  const limited = await rateLimit(`flow-execute:${auth.organizationId}`, { limit: 30, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many runs — wait a moment before running this flow again.', 429, 'RATE_LIMITED')
  // Monthly token ceiling: flows (esp. pure ai/tool flows with no agent nodes)
  // otherwise bypass the budget the agent runtime enforces. A single run is
  // bounded by maxSteps; this blocks STARTING one once the workspace is over.
  const budget = await checkMonthlyTokenBudget(auth.organizationId, auth.dbUser.id)
  if (budget.over) throw new ApiError('Monthly token budget reached for this workspace.', 429, 'BUDGET_EXCEEDED')
  // Visibility gate: a private flow may only be run by its owner.
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const body = await request.json().catch(() => ({}))
  // Replies must carry content: an all-whitespace reply would resume a paused
  // step with an empty answer (the UI disables empty sends; this guards the API).
  const parsed = z
    .object({
      input: z.unknown().optional(),
      flowRunId: z.string().optional(),
      reply: z.string().refine((value) => value.trim().length > 0, 'Reply cannot be empty.').optional(),
      // Re-run from a step: replay fromRunId's outputs up to fromNodeId, then
      // execute from that step onward on the SAME pinned graph.
      fromRunId: z.string().optional(),
      fromNodeId: z.string().optional(),
      // Partial execution from the node editor: run through a node ("Execute
      // step") or up to but not including it ("Execute previous nodes").
      stopAfterNodeId: z.string().optional(),
      stopBeforeNodeId: z.string().optional(),
      // "Pretend this step produced X", keyed by node id (or `node#i` inside a
      // loop). Rides alongside fromRunId/fromNodeId.
      overrides: z.record(z.string(), z.unknown()).optional(),
      // 'fork' (default) starts a NEW run — new idempotency keys, so external
      // writes re-fire. 'patch' reopens the SAME failed run, keeping its keys.
      mode: z.enum(['fork', 'patch']).optional(),
    })
    .parse(body)
  if (parsed.mode === 'patch' && !(parsed.fromRunId && parsed.fromNodeId)) {
    throw new ApiError('Patching a run needs both fromRunId and fromNodeId.', 400, 'FLOW_REPLAY_ARGS')
  }
  if (parsed.stopAfterNodeId && parsed.stopBeforeNodeId) {
    throw new ApiError('Pick one of stopAfterNodeId or stopBeforeNodeId.', 400, 'FLOW_PARTIAL_ARGS')
  }
  // flowRunId only resumes a paused run when paired with the user's reply —
  // without a reply there is nothing to resume with, and silently starting a
  // fresh run instead would strand the caller's expectation of continuity.
  if (parsed.flowRunId && parsed.reply === undefined) {
    throw new ApiError('flowRunId requires a reply — to start a new run, omit flowRunId.', 400, 'FLOW_RESUME_REQUIRES_REPLY')
  }
  if ((parsed.fromRunId === undefined) !== (parsed.fromNodeId === undefined)) {
    throw new ApiError('Re-running from a step needs both fromRunId and fromNodeId.', 400, 'FLOW_REPLAY_ARGS')
  }
  if (parsed.fromRunId && parsed.flowRunId) {
    throw new ApiError('Pick one: resume a paused run (flowRunId + reply) or re-run from a step (fromRunId + fromNodeId).', 400, 'FLOW_REPLAY_ARGS')
  }
  // Resume hardening: the run being resumed must belong to THIS flow and org —
  // otherwise a crafted flowRunId could re-interpret another flow's run
  // against this flow's graph.
  if (parsed.flowRunId) {
    const owned = await prisma.flowRun.findFirst({
      where: { id: parsed.flowRunId, flowId: flow.id, organizationId: auth.organizationId },
      select: { id: true, status: true },
    })
    if (!owned) throw new ApiError('Run not found', 404, 'NOT_FOUND')
    // Friendly synchronous check — the worker's atomic waiting→running claim
    // is still the authority (a lost race there fails the queued job), but a
    // reply to a run that plainly is not waiting should 409 immediately.
    if (owned.status !== 'waiting') {
      throw new ApiError('This run is not waiting for input', 409, 'FLOW_RUN_NOT_WAITING')
    }
    // A run paused on a tool-step APPROVAL resumes only through the approvals
    // route (which calls runFlowExecution directly with the decision payload,
    // never through this endpoint). A user-supplied reply here must never be
    // interpreted as — or race with — an approval decision.
    if (parsed.reply !== undefined) {
      const steps = await prisma.flowRunStep.findMany({
        where: { flowRunId: owned.id },
        orderBy: { order: 'asc' },
        select: { nodeId: true, status: true, output: true },
      })
      if (deriveRunWaiting(owned.status, steps)?.kind === 'approval') {
        throw new ApiError('This run is waiting for an approval decision, not a reply.', 400, 'FLOW_RUN_AWAITING_APPROVAL')
      }
    }
    // Resume durably: hand the reply to the dispatcher and return at once.
    // The run row already exists; the builder/activity pages poll it live.
    await dispatchDetachedFlowExecution({
      flowId: id,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      input: parseFlowInput(parsed.input),
      flowRunId: parsed.flowRunId,
      reply: parsed.reply,
    })
    return { success: true, run: { flowRunId: parsed.flowRunId, status: 'running', output: null } }
  }
  // Patch-and-resume: reopen the SAME failed run from a chosen step, with any
  // overrides applied. Ownership-checked like the resume path above — a crafted
  // fromRunId must never re-enter another flow's run against this graph.
  if (parsed.mode === 'patch' && parsed.fromRunId && parsed.fromNodeId) {
    const owned = await prisma.flowRun.findFirst({
      where: { id: parsed.fromRunId, flowId: flow.id, organizationId: auth.organizationId },
      select: { id: true, status: true },
    })
    if (!owned) throw new ApiError('Run not found', 404, 'NOT_FOUND')
    // Friendly synchronous check; the worker's atomic failed→running claim is
    // still the authority for concurrent patches.
    if (owned.status !== 'failed') {
      throw new ApiError(
        'Only a failed run can be patched and resumed. Start a separate run instead.',
        409,
        'FLOW_PATCH_NOT_FAILED',
      )
    }
    await dispatchDetachedFlowExecution({
      flowId: id,
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      flowRunId: parsed.fromRunId,
      resumeFrom: { nodeId: parsed.fromNodeId },
      overrides: parsed.overrides,
    })
    if (parsed.overrides && Object.keys(parsed.overrides).length) {
      await recordAudit({
        organizationId: auth.organizationId,
        action: 'flow.run_overridden',
        actorUserId: auth.dbUser.id,
        resourceType: 'flow',
        resourceId: flow.id,
        detail: { mode: 'patch', nodes: Object.keys(parsed.overrides), fromRunId: parsed.fromRunId },
      })
    }
    return { success: true, run: { flowRunId: parsed.fromRunId, status: 'running', output: null } }
  }

  // Fresh run (or re-run from a step): the run row is created and validated
  // BEFORE this returns — invalid graphs/input still fail the request — and
  // execution continues in the background, surviving client navigation.
  const run = await startFlowExecution({
    flowId: id,
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    input: parseFlowInput(parsed.input),
    replayFrom: parsed.fromRunId && parsed.fromNodeId ? { runId: parsed.fromRunId, nodeId: parsed.fromNodeId } : undefined,
    ...(parsed.overrides ? { overrides: parsed.overrides } : {}),
    ...(parsed.stopAfterNodeId ? { stopAfterNodeId: parsed.stopAfterNodeId } : {}),
    ...(parsed.stopBeforeNodeId ? { stopBeforeNodeId: parsed.stopBeforeNodeId } : {}),
  })
  if (parsed.overrides && Object.keys(parsed.overrides).length) {
    await recordAudit({
      organizationId: auth.organizationId,
      action: 'flow.run_overridden',
      actorUserId: auth.dbUser.id,
      resourceType: 'flow',
      resourceId: flow.id,
      detail: { mode: 'fork', nodes: Object.keys(parsed.overrides), fromRunId: parsed.fromRunId ?? null },
    })
  }
  return { success: true, run }
}, { permission: 'flow.run' })
