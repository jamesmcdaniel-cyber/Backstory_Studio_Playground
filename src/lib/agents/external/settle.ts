/**
 * Settling an external agent's run: its reply, its deadline, or a delivery
 * the outbox gave up on — and handing the settled run back to the normal
 * completion path.
 *
 * One mechanism for all three. `settleExternalExecution` consumes the run's
 * single-use reply capability and records what settled it, in the SAME
 * transaction as an `agent.external.settle` outbox row, so an accepted reply
 * can be delayed by an outage but never lost. The outbox handler then resumes
 * the run the way any paused run resumes:
 *
 *   - owned by a waiting flow  → resume the FLOW, which re-enters its agent
 *     step, so the output flows on to the next step;
 *   - otherwise                → resume the bare agent run.
 *
 * Either way the runner (src/features/agents/external-run.ts) claims
 * waiting_for_external → running atomically and finalizes through the shared
 * completion effects: status, notification, the Slack thread answered as the
 * teammate, the chat reply, the `agent.completed` signal.
 */

import { Prisma } from '@prisma/client'
import { prisma, systemPrisma, tenantTransaction } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { externalAgentSettleOutboxEvent, processOutboxEventById } from '@/lib/outbox'
import { recordLedgerEntry } from '@/lib/agents/action-ledger'
import { broadcastAgentEventTick } from '@/lib/flows/run-stream'
import { isTerminalRunStatus } from '@/lib/agents/run-status'
import { WAITING_FOR_EXTERNAL, webhookHostOf, type ExternalReply } from './types'

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export function isExternalSettlePayload(value: unknown): value is { executionId: string } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && typeof (value as Record<string, unknown>).executionId === 'string'
}

/** The settled reply recorded on a waiting run, if any. */
export function readExternalReply(metadata: unknown): ExternalReply | null {
  const reply = asRecord(asRecord(asRecord(metadata).external).reply)
  if (reply.status !== 'completed' && reply.status !== 'failed') return null
  return {
    status: reply.status,
    output: typeof reply.output === 'string' ? reply.output : '',
    links: Array.isArray(reply.links)
      ? reply.links
          .map((link) => asRecord(link))
          .filter((link) => typeof link.url === 'string')
          .map((link) => ({ title: typeof link.title === 'string' ? link.title : String(link.url), url: String(link.url) }))
      : [],
    source: reply.source === 'timeout' || reply.source === 'delivery' || reply.source === 'removed' ? reply.source : 'agent',
    receivedAt: typeof reply.receivedAt === 'string' ? reply.receivedAt : new Date().toISOString(),
  }
}

/**
 * Consume the run's reply capability and record what settled it. Returns the
 * settle outbox row's id, or null when the run was not waiting on this
 * capability (already settled, cancelled, expired, or the token did not
 * match) — the caller answers every one of those identically.
 *
 * `tokenHash` is set when the agent itself replied: the consume then matches
 * that exact hash AND an unexpired deadline. The platform's own settles
 * (timeout, delivery failure, removal) match whatever capability is live.
 */
export async function settleExternalExecution(params: {
  organizationId: string
  executionId: string
  reply: Omit<ExternalReply, 'receivedAt'>
  tokenHash?: string
  now?: Date
}): Promise<string | null> {
  const now = params.now ?? new Date()
  return tenantTransaction(params.organizationId, async (tx) => {
    const execution = await tx.agentExecution.findFirst({
      where: { id: params.executionId, organizationId: params.organizationId, status: WAITING_FOR_EXTERNAL },
      select: { metadata: true, replyTokenHash: true },
    })
    if (!execution?.replyTokenHash) return null
    if (params.tokenHash && !timingSafeEqualHex(params.tokenHash, execution.replyTokenHash)) return null
    const metadata = asRecord(execution.metadata)
    const reply: ExternalReply = { ...params.reply, receivedAt: now.toISOString() }
    const consumed = await tx.agentExecution.updateMany({
      where: {
        id: params.executionId,
        organizationId: params.organizationId,
        status: WAITING_FOR_EXTERNAL,
        replyTokenHash: execution.replyTokenHash,
        ...(params.tokenHash ? { replyTokenExpiresAt: { gt: now } } : {}),
      },
      data: {
        replyTokenHash: null,
        replyTokenExpiresAt: null,
        metadata: { ...metadata, external: { ...asRecord(metadata.external), reply } } as Prisma.InputJsonValue,
      },
    })
    if (consumed.count !== 1) return null
    const event = await tx.outboxEvent.create({
      data: externalAgentSettleOutboxEvent({ organizationId: params.organizationId, executionId: params.executionId }),
      select: { id: true },
    })
    return event.id
  })
}

/** Try the settle right away; the outbox poller retries anything this does not finish. */
export async function kickSettle(outboxEventId: string): Promise<void> {
  await processOutboxEventById(outboxEventId).catch((error) =>
    apiLogger.warn('external settle: immediate attempt failed; the outbox will retry', {
      outboxEventId,
      error: error instanceof Error ? error.message : String(error),
    }),
  )
}

// ── The reply capability ────────────────────────────────────────────────────

export type ReplyCapability = {
  executionId: string
  agentTaskId: string
  externalAgentId: string
  webhookHost: string
  userId: string
  replyTokenHash: string
}

/**
 * Is this the agent's own key, presenting the live token of one of ITS tasks?
 * Null for every failure — unknown execution, another agent's execution, no
 * token minted, wrong token, expired, already settled — so the routes can
 * answer all of them with one indistinguishable 404.
 */
export async function verifyReplyCapability(params: {
  organizationId: string
  apiKeyId: string
  executionId: string
  presentedToken: string
  now?: Date
}): Promise<ReplyCapability | null> {
  const now = params.now ?? new Date()
  if (!params.presentedToken || params.presentedToken.length > 256) return null
  const external = await prisma.externalAgent.findFirst({
    where: { organizationId: params.organizationId, apiKeyId: params.apiKeyId },
    select: { id: true, agentTaskId: true, webhookUrl: true },
  })
  if (!external) return null
  const execution = await prisma.agentExecution.findFirst({
    where: { id: params.executionId, organizationId: params.organizationId, agentTaskId: external.agentTaskId },
    select: { id: true, status: true, userId: true, replyTokenHash: true, replyTokenExpiresAt: true },
  })
  if (!execution?.replyTokenHash || execution.status !== WAITING_FOR_EXTERNAL) return null
  if (!execution.replyTokenExpiresAt || execution.replyTokenExpiresAt <= now) return null
  if (!timingSafeEqualHex(hashToken(params.presentedToken), execution.replyTokenHash)) return null
  return {
    executionId: execution.id,
    agentTaskId: external.agentTaskId,
    externalAgentId: external.id,
    webhookHost: webhookHostOf(external.webhookUrl),
    userId: execution.userId,
    replyTokenHash: execution.replyTokenHash,
  }
}

/**
 * Accept an agent's reply: verify, consume, record. Returns the settle outbox
 * row's id (kick it to finish now), or null for any failure.
 */
export async function acceptExternalReply(params: {
  organizationId: string
  apiKeyId: string
  executionId: string
  presentedToken: string
  reply: { status: 'completed' | 'failed'; output: string; links: Array<{ title: string; url: string }> }
  now?: Date
}): Promise<string | null> {
  const capability = await verifyReplyCapability(params)
  if (!capability) return null
  const settleId = await settleExternalExecution({
    organizationId: params.organizationId,
    executionId: capability.executionId,
    reply: { ...params.reply, source: 'agent' },
    tokenHash: capability.replyTokenHash,
    now: params.now,
  })
  if (!settleId) return null
  await prisma.externalAgent
    .update({ where: { id: capability.externalAgentId, organizationId: params.organizationId }, data: { lastReplyAt: params.now ?? new Date() } })
    .catch(() => undefined)
  await recordExecutionEvent(capability.executionId, 'external.replied', { status: params.reply.status })
  await recordLedgerEntry(
    {
      organizationId: params.organizationId,
      source: { kind: 'agent', agentTaskId: capability.agentTaskId, runId: capability.executionId },
      actorUserId: capability.userId,
      provider: `external:${capability.webhookHost}`,
      plane: 'external',
      tool: 'reply_received',
      args: { status: params.reply.status, output: params.reply.output, links: params.reply.links.map((link) => link.url) },
      isWrite: true,
    },
    { status: params.reply.status === 'completed' ? 'done' : 'failed', ...(params.reply.status === 'failed' ? { error: params.reply.output.slice(0, 300) } : {}) },
  )
  return settleId
}

/** Most interim lines one run keeps — a chatty agent must not flood the feed. */
export const EXTERNAL_PROGRESS_LIMIT = 200

/** An interim status line, narrated in the run's feed. False when over the cap. */
export async function recordExternalProgress(params: { executionId: string; text: string }): Promise<boolean> {
  const count = await systemPrisma.workflowEvent.count({ where: { executionId: params.executionId, kind: 'external.progress' } })
  if (count >= EXTERNAL_PROGRESS_LIMIT) return false
  await recordExecutionEvent(params.executionId, 'external.progress', { text: params.text })
  return true
}

async function recordExecutionEvent(executionId: string, kind: string, payload: Record<string, unknown>) {
  // systemPrisma: WorkflowEvent has no organizationId column; every caller
  // resolved this execution id against its organization first.
  await systemPrisma.workflowEvent.create({ data: { executionId, kind, payload: payload as Prisma.InputJsonValue } })
  broadcastAgentEventTick(executionId)
}

// ── The settle outbox handler ───────────────────────────────────────────────

/** Thrown (and retried by the outbox) while the owning flow has not finished pausing. */
export class FlowNotPausedYetError extends Error {
  constructor() {
    super('The flow that owns this run has not finished pausing yet.')
    this.name = 'FlowNotPausedYetError'
  }
}

/**
 * Resume a settled external run through the path that owns it. Idempotent: a
 * run that is no longer waiting (already finalized, cancelled) is done.
 */
export async function deliverExternalSettle(organizationId: string, payload: { executionId: string }, deliveryId?: string): Promise<void> {
  // systemPrisma: outbox handler (worker/cron, no request context); pinned to
  // the outbox event's organization.
  const execution = await systemPrisma.agentExecution.findFirst({
    where: { id: payload.executionId, organizationId },
    select: { id: true, status: true, agentTaskId: true, userId: true, metadata: true, trigger: true },
  })
  if (!execution || execution.status !== WAITING_FOR_EXTERNAL || !execution.agentTaskId) return
  const reply = readExternalReply(execution.metadata)
  if (!reply) return

  const trigger = asRecord(execution.trigger)
  if (trigger.type === 'flow' && typeof trigger.flowRunId === 'string') {
    // systemPrisma: same outbox context; pinned to the organization.
    const run = await systemPrisma.flowRun.findFirst({
      where: { id: trigger.flowRunId, organizationId },
      select: { id: true, flowId: true, status: true, userId: true, trigger: true },
    })
    if (run && ['running', 'pending', 'queued'].includes(run.status)) {
      // The agent answered before its flow finished recording the pause (a
      // fast agent replying inside the webhook call). Retried shortly; by then
      // the run is `waiting` and resumes below.
      throw new FlowNotPausedYetError()
    }
    if (run?.status === 'waiting') {
      // systemPrisma: FlowRunStep has no organizationId; scoped through the run above.
      const step = await systemPrisma.flowRunStep.findFirst({
        where: { flowRunId: run.id, agentExecutionId: execution.id, status: 'waiting' },
        orderBy: { startedAt: 'desc' },
        select: { nodeId: true },
      })
      if (step) {
        const { dispatchFlowExecution } = await import('@/features/flows/execute-flow')
        const triggerType = asRecord(run.trigger).type
        await dispatchFlowExecution({
          flowId: run.flowId,
          flowRunId: run.id,
          organizationId,
          userId: run.userId ?? execution.userId,
          input: {},
          // The runner reads the settled reply from the execution itself; this
          // string only satisfies the resume contract.
          reply: reply.output.slice(0, 8000),
          replyStepKey: step.nodeId,
          usePublished: Boolean(typeof triggerType === 'string' && triggerType !== 'manual'),
          ...(deliveryId ? { deliveryId } : {}),
        })
        return
      }
    }
    // A flow run that already ended (failed, cancelled): finish the bare
    // agent run so its own record says what happened.
  }

  const { resumeAgentExecution } = await import('@/features/agents/execute-agent')
  try {
    await resumeAgentExecution({
      executionId: execution.id,
      agentId: execution.agentTaskId,
      organizationId,
      userId: execution.userId,
      reply: reply.output.slice(0, 8000),
    })
  } catch (error) {
    // A failed reply finalizes the run and then throws (so a flow step reads it
    // as a failure). Once the run is terminal, the settle is done.
    // systemPrisma: re-read of the row loaded above.
    const after = await systemPrisma.agentExecution.findFirst({ where: { id: execution.id, organizationId }, select: { status: true } })
    if (after && isTerminalRunStatus(after.status)) return
    throw error
  }
}

// ── Timeouts ────────────────────────────────────────────────────────────────

/**
 * Fail external runs whose agent never answered by the deadline. Driven by the
 * dispatch tick; cross-tenant by design (CRON_SECRET-gated), each settle then
 * re-scoped to its own organization.
 */
export async function reapExpiredExternalExecutions(now: Date = new Date()): Promise<{ timedOut: number }> {
  // systemPrisma: global deadline sweep across all orgs, bounded per tick.
  const expired = await systemPrisma.agentExecution.findMany({
    where: { status: WAITING_FOR_EXTERNAL, replyTokenExpiresAt: { lt: now } },
    select: { id: true, organizationId: true, agentTaskId: true, metadata: true },
    orderBy: { replyTokenExpiresAt: 'asc' },
    take: 100,
  })
  let timedOut = 0
  for (const execution of expired) {
    const external = asRecord(asRecord(execution.metadata).external)
    const name = typeof external.agentName === 'string' && external.agentName ? external.agentName : 'The external agent'
    const minutes = Number(external.timeoutMinutes)
    const window = Number.isFinite(minutes) && minutes > 0 ? (minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minute${minutes === 1 ? '' : 's'}`) : 'its deadline'
    try {
      const settleId = await settleExternalExecution({
        organizationId: execution.organizationId,
        executionId: execution.id,
        reply: { status: 'failed', output: `${name} did not reply within ${window}, so the run was stopped.`, links: [], source: 'timeout' },
        now,
      })
      if (settleId) {
        timedOut += 1
        await kickSettle(settleId)
      }
    } catch (error) {
      apiLogger.error('external agent timeout settle failed', {
        executionId: execution.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { timedOut }
}
