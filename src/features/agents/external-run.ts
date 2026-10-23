/**
 * The agent runtime's branch for an EXTERNAL agent — one running on someone
 * else's infrastructure. Entered from runAgentExecutionInner the moment the
 * agent row loads, before any model setup: an external agent has no model, no
 * tools and no prompt of ours.
 *
 * Fresh run:  park the execution in `waiting_for_external` with a hashed
 *             single-use reply token, and hand the signed task to the outbox
 *             (first attempt immediately). Returns `{ status: 'waiting_for_external' }`
 *             — every caller already treats a `waiting…` status as a pause.
 * Resume:     the run was settled (src/lib/agents/external/settle.ts). Claim
 *             waiting → running atomically and finalize through the same
 *             effects as any completed run: status, the agent's counters, the
 *             `agent.completed` signal, the notification, the Slack thread
 *             answered as the teammate, the chat reply.
 *
 * Every caller works unchanged: manual Run, the agent's Assistant chat, a
 * Slack mention or slash command, a flow agent step, a schedule, a signal.
 */

import { Prisma, type AgentTask } from '@prisma/client'
import { prisma, systemPrisma, tenantTransaction } from '@/lib/prisma'
import { encryptSecret, hashToken } from '@/lib/crypto/secrets'
import { externalAgentTaskOutboxEvent, flowSignalOutboxEvent, processOutboxEventById } from '@/lib/outbox'
import { apiLogger } from '@/lib/logger'
import { notify } from '@/lib/notifications/service'
import { broadcastAgentEventTick } from '@/lib/flows/run-stream'
import { indexExecution } from '@/lib/rag/indexer'
import { aiEgressRefusal } from '@/lib/usage/ai-guard'
import { AgentRunRefusedError } from '@/lib/agents/run-errors'
import { mintReplyToken } from '@/lib/agents/external/signing'
import { buildExternalTaskPayload } from '@/lib/agents/external/payload'
import { readExternalReply } from '@/lib/agents/external/settle'
import { WAITING_FOR_EXTERNAL, webhookHostOf, type ExternalReply } from '@/lib/agents/external/types'
import type { AgentExecutionJob } from './execute-agent'

type RunData = AgentExecutionJob & { onExecutionCreated?: (executionId: string) => void | Promise<void> }

type ExecutionRow = {
  id: string
  status: string
  userId: string
  organizationId: string
  trigger: Prisma.JsonValue
  metadata: Prisma.JsonValue
  input: Prisma.JsonValue
  output?: Prisma.JsonValue
  error?: string | null
  startedAt: Date
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

function agentTitle(agent: Pick<AgentTask, 'description' | 'metadata'>): string {
  const title = asRecord(agent.metadata).title
  return (typeof title === 'string' && title.trim()) || agent.description.split('\n')[0] || 'External agent'
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue
}

async function recordEvent(executionId: string, kind: string, payload: Record<string, unknown>) {
  await prisma.workflowEvent.create({ data: { executionId, kind, payload: json(payload) } }).catch(() => undefined)
  broadcastAgentEventTick(executionId)
}

function announceExecution(data: RunData, executionId: string) {
  if (!data.onExecutionCreated) return
  try {
    void Promise.resolve(data.onExecutionCreated(executionId)).catch(() => undefined)
  } catch {
    // Best-effort notification only, exactly like the main runtime.
  }
}

export async function runExternalAgentExecution(agentRow: AgentTask, data: RunData) {
  return data.resume ? resumeSettled(agentRow, data) : dispatchTask(agentRow, data)
}

// ── Dispatch ────────────────────────────────────────────────────────────────

async function dispatchTask(agentRow: AgentTask, data: RunData) {
  const { organizationId, userId } = data
  if (agentRow.status !== 'ACTIVE') throw new AgentRunRefusedError('Agent not found or inactive', 'AGENT_UNAVAILABLE')

  const queued = data.executionId
    ? await prisma.agentExecution.findFirst({ where: { id: data.executionId, agentTaskId: agentRow.id, organizationId } })
    : null
  if (data.executionId && !queued) throw new AgentRunRefusedError('Queued execution does not match this tenant and agent', 'EXECUTION_MISMATCH')
  // A re-delivered job for a run that already left `pending`: nothing to do.
  if (queued && queued.status !== 'pending') return { status: queued.status, skipped: true as const }

  const name = agentTitle(agentRow)
  const input = (data.input ?? '').trim() || agentRow.objective
  let execution: ExecutionRow
  if (queued) {
    // systemPrisma: id-keyed claim on worker job data; validated against this
    // tenant and agent just above.
    const claimed = await systemPrisma.agentExecution.updateMany({
      where: { id: queued.id, status: 'pending' },
      data: { status: 'running', startedAt: new Date() },
    })
    if (claimed.count === 0) return { status: 'running', skipped: true as const }
    execution = { ...queued, status: 'running' }
  } else {
    execution = await prisma.agentExecution.create({
      data: {
        agentType: agentRow.agentType,
        agentTaskId: agentRow.id,
        status: 'running',
        input: { prompt: input },
        // A flow step says where it came from, so the task can tell the agent
        // and a settled reply can resume the flow that owns the run.
        trigger: json(data.origin ? { ...data.origin, type: 'flow' } : { type: 'schedule' }),
        metadata: { title: name },
        userId,
        organizationId,
      },
    })
  }
  announceExecution(data, execution.id)
  await prisma.executionMessage.create({ data: { executionId: execution.id, role: 'user', content: input } })

  try {
    const external = await prisma.externalAgent.findFirst({
      where: { agentTaskId: agentRow.id, organizationId },
      select: { id: true, webhookUrl: true, replyTimeoutMinutes: true },
    })
    if (!external) throw new Error(`${name} has no delivery settings. Register it again from the Agents page.`)

    // A workspace that switched AI off has said its data does not leave for an
    // AI system; an external agent is one, whoever operates it.
    const refusal = await aiEgressRefusal({ organizationId, userId, surface: 'agent.external', resourceType: 'agent_execution', resourceId: execution.id })
    if (refusal) throw refusal

    const requester = await prisma.user.findFirst({ where: { id: userId, organizationId }, select: { name: true } })
    const token = mintReplyToken()
    const deadline = new Date(Date.now() + external.replyTimeoutMinutes * 60_000)
    const host = webhookHostOf(external.webhookUrl)
    const payload = buildExternalTaskPayload({
      executionId: execution.id,
      agent: { id: agentRow.id, name },
      input,
      trigger: execution.trigger,
      requesterName: requester?.name?.trim() || null,
      replyToken: token,
      replyExpiresAt: deadline,
    })
    const metadata = {
      ...asRecord(execution.metadata),
      external: { agentName: name, webhookHost: host, deadlineAt: deadline.toISOString(), timeoutMinutes: external.replyTimeoutMinutes },
    }
    // Park the run and enqueue its delivery in one commit: a task is never
    // sent for a run that is not waiting on it, and a waiting run always has
    // a delivery behind it.
    const outboxEventId = await tenantTransaction(organizationId, async (tx) => {
      const parked = await tx.agentExecution.updateMany({
        where: { id: execution.id, organizationId, status: 'running' },
        data: {
          status: WAITING_FOR_EXTERNAL,
          replyTokenHash: hashToken(token),
          replyTokenExpiresAt: deadline,
          metadata: json(metadata),
        },
      })
      if (parked.count !== 1) return null
      const event = await tx.outboxEvent.create({
        data: externalAgentTaskOutboxEvent({ organizationId, executionId: execution.id, encryptedBody: encryptSecret(JSON.stringify(payload)) }),
        select: { id: true },
      })
      return event.id
    })
    // Cancelled between the claim and here: the cancel stands.
    if (!outboxEventId) return { status: 'cancelled', executionId: execution.id }
    await recordEvent(execution.id, 'external.dispatched', { host, deadlineAt: deadline.toISOString() })

    // First attempt now — the outbox poller owns every retry after it.
    await processOutboxEventById(outboxEventId).catch((error) =>
      apiLogger.warn('external agent: first delivery attempt errored; the outbox will retry', {
        executionId: execution.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    )
    // The attempt may already have settled the run: a refusal fails it at
    // once, and a fast agent can answer inside the webhook call.
    const settled = await finishIfSettled(agentRow, data, execution.id)
    if (settled) return settled
    return { status: WAITING_FOR_EXTERNAL, executionId: execution.id, question: `Waiting for ${name} to reply` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // systemPrisma: id-keyed terminal write; validated/created above.
    const live = await systemPrisma.agentExecution.findUnique({ where: { id: execution.id }, select: { status: true } })
    if (live && live.status !== WAITING_FOR_EXTERNAL && live.status !== 'running') throw error
    await finalizeFailure(agentRow, { ...execution, status: 'running' }, message)
    throw error
  }
}

/**
 * When a run settled while its dispatcher was still on the line, finish it
 * here and return the result — the caller (a flow step, a chat turn) then
 * continues without ever pausing. Null when the run is still waiting.
 */
async function finishIfSettled(agentRow: AgentTask, data: RunData, executionId: string) {
  // systemPrisma: id-keyed re-read of the row this run created/claimed.
  const row = await systemPrisma.agentExecution.findUnique({ where: { id: executionId } })
  if (!row) return null
  if (row.status === 'completed') return { summary: String(asRecord(row.output).summary ?? ''), executionId }
  if (row.status === 'failed') throw new Error(row.error || 'The external agent run failed.')
  if (row.status !== WAITING_FOR_EXTERNAL || row.replyTokenHash) return null
  const reply = readExternalReply(row.metadata)
  if (!reply) return null
  return claimAndFinalize(agentRow, data, row, reply)
}

// ── Resume ──────────────────────────────────────────────────────────────────

async function resumeSettled(agentRow: AgentTask, data: RunData) {
  const { organizationId } = data
  if (!data.executionId) throw new AgentRunRefusedError('Resume requested without an execution', 'RESUME_WITHOUT_EXECUTION')
  const row = await prisma.agentExecution.findFirst({ where: { id: data.executionId, agentTaskId: agentRow.id, organizationId } })
  if (!row) throw new AgentRunRefusedError('Resume requested without an execution', 'RESUME_WITHOUT_EXECUTION')
  // Only a SETTLED run resumes: its capability consumed and its reply recorded
  // by the reply API (or the timeout, or a failed delivery). A person resuming
  // the owning flow with their own text cannot answer for the agent.
  const reply = row.status === WAITING_FOR_EXTERNAL && !row.replyTokenHash ? readExternalReply(row.metadata) : null
  if (!reply) throw new AgentRunRefusedError('Execution is not waiting for an external reply', 'NOT_AWAITING_REPLY')
  const result = await claimAndFinalize(agentRow, data, row, reply)
  if (!result) throw new AgentRunRefusedError('Execution is not waiting for an external reply', 'NOT_AWAITING_REPLY')
  return result
}

async function claimAndFinalize(agentRow: AgentTask, data: RunData, row: ExecutionRow, reply: ExternalReply) {
  // Atomic claim: the settle handler, a flow resume and the dispatcher's own
  // re-read can all reach a settled run; exactly one finalizes it.
  // systemPrisma: id-keyed claim; the row was validated against this tenant.
  const claimed = await systemPrisma.agentExecution.updateMany({
    where: { id: row.id, status: WAITING_FOR_EXTERNAL, replyTokenHash: null },
    data: { status: 'running' },
  })
  if (claimed.count === 0) return null
  announceExecution(data, row.id)
  if (reply.status === 'completed') return finalizeSuccess(agentRow, { ...row, status: 'running' }, reply)
  await finalizeFailure(agentRow, { ...row, status: 'running' }, reply.output)
  throw new Error(reply.output)
}

// ── Completion ──────────────────────────────────────────────────────────────

/** Strip the settled reply off the metadata once it lives in the output. */
function settledMetadata(row: ExecutionRow, source: ExternalReply['source'] | 'error'): Prisma.InputJsonValue {
  const metadata = asRecord(row.metadata)
  const external = { ...asRecord(metadata.external) }
  delete external.reply
  return json({ ...metadata, pendingQuestion: null, external: { ...external, settledBy: source } })
}

function triggerLink(row: ExecutionRow): string | null {
  const link = asRecord(row.trigger).link
  return typeof link === 'string' && link.startsWith('/') ? link : null
}

/** The agent's Assistant chat started this run: its answer lands in that thread. */
async function postChatReply(agentRow: AgentTask, row: ExecutionRow, content: string, status: string) {
  const trigger = asRecord(row.trigger)
  if (trigger.source !== 'assistant' || typeof trigger.chatSessionId !== 'string') return
  await prisma.agentChatMessage
    .create({
      data: {
        agentTaskId: agentRow.id,
        organizationId: row.organizationId,
        userId: row.userId,
        sessionId: trigger.chatSessionId,
        role: 'assistant',
        content,
        metadata: { run: { executionId: row.id, status, task: String(asRecord(row.input).prompt ?? '').slice(0, 500) } },
      },
    })
    .catch((error) => apiLogger.warn('external agent: chat reply not saved', { executionId: row.id, error: error instanceof Error ? error.message : String(error) }))
}

function renderLinks(reply: ExternalReply): string {
  if (!reply.links.length) return reply.output
  const list = reply.links.map((link) => `- [${link.title.replace(/[[\]]/g, '')}](${link.url})`).join('\n')
  return `${reply.output.trim()}\n\n${list}`
}

async function finalizeSuccess(agentRow: AgentTask, row: ExecutionRow, reply: ExternalReply) {
  const { organizationId } = row
  const name = agentTitle(agentRow)
  const summary = renderLinks(reply).trim() || `${name} replied with no text.`
  const output = { summary, external: { links: reply.links, repliedAt: reply.receivedAt } }
  const now = new Date()
  await prisma.executionMessage.create({ data: { executionId: row.id, role: 'agent', content: summary } })
  // systemPrisma: id-keyed terminal writes; ids validated against this tenant.
  await systemPrisma.$transaction([
    systemPrisma.agentExecution.update({
      where: { id: row.id },
      data: {
        status: 'completed',
        output: json(output),
        error: null,
        completedAt: now,
        executionTime: Math.max(0, now.getTime() - row.startedAt.getTime()),
        metadata: settledMetadata(row, reply.source),
      },
    }),
    systemPrisma.agentTask.update({
      where: { id: agentRow.id },
      data: { lastExecutedAt: now, executionCount: { increment: 1 }, lastResult: json(output) },
    }),
    systemPrisma.outboxEvent.create({
      data: flowSignalOutboxEvent({
        organizationId,
        aggregateId: row.id,
        dedupeKey: `agent:${row.id}:completed`,
        signal: { signal: 'agent.completed', payload: { agentId: agentRow.id, executionId: row.id, summary: summary.slice(0, 2000) }, depth: 1 },
      }),
    }),
  ])
  const link = triggerLink(row)
  await notify({
    organizationId,
    userId: row.userId,
    type: 'agent.completed',
    level: 'success',
    title: `${name} completed`,
    body: summary,
    agentTaskId: agentRow.id,
    executionId: row.id,
    ...(link ? { link } : {}),
  })
  broadcastAgentEventTick(row.id)
  // A Slack-started run answers in its thread, posted as the teammate.
  await import('@/lib/slack/reply')
    .then(({ finishSlackMentionForExecution }) => finishSlackMentionForExecution(row.id, summary))
    .catch(() => undefined)
  await postChatReply(agentRow, row, summary, 'completed')
  void indexExecution({
    id: row.id,
    organizationId,
    agentTaskId: agentRow.id,
    agentTitle: name,
    signalId: null,
    input: row.input,
    output,
    status: 'completed',
    ownerUserId: agentRow.userId ?? null,
    visibility: agentRow.visibility === 'private' ? 'private' : 'shared',
  }).catch(() => undefined)
  return { summary, executionId: row.id }
}

async function finalizeFailure(agentRow: AgentTask, row: ExecutionRow, message: string) {
  const { organizationId } = row
  const name = agentTitle(agentRow)
  const reason = message.slice(0, 300)
  const now = new Date()
  // systemPrisma: id-keyed terminal write; validated against this tenant.
  await systemPrisma.agentExecution.update({
    where: { id: row.id },
    data: {
      status: 'failed',
      error: reason,
      completedAt: now,
      executionTime: Math.max(0, now.getTime() - row.startedAt.getTime()),
      replyTokenHash: null,
      replyTokenExpiresAt: null,
      metadata: settledMetadata(row, readExternalReply(row.metadata)?.source ?? 'error'),
    },
  })
  await import('@/lib/slack/reply')
    .then(({ finishSlackMentionForExecution }) => finishSlackMentionForExecution(row.id, `That run failed. ${reason}`))
    .catch(() => undefined)
  await postChatReply(agentRow, row, `The run failed: ${reason}`, 'failed')
  const link = triggerLink(row)
  await notify({
    organizationId,
    userId: row.userId,
    type: 'agent.error',
    level: 'error',
    title: `${name} hit an error`,
    body: reason,
    agentTaskId: agentRow.id,
    executionId: row.id,
    ...(link ? { link } : {}),
  })
  broadcastAgentEventTick(row.id)
}
