/**
 * Delivering one task to an external agent's webhook — the outbox handler for
 * `agent.external.task`.
 *
 * The outbox owns retries, backoff and the attempt ceiling: this throws on a
 * failure and the outbox decides. A refusal no retry can fix (a 4xx other
 * than 408/429, a URL the SSRF guard will not allow) throws a
 * PermanentOutboxError so the run fails at once with the reason; when the
 * outbox gives up for good, `externalDeliveryGaveUp` fails the run through the
 * normal completion path (Slack thread, flow step, chat, notification).
 *
 * Every attempt: the URL is re-checked by the SSRF guard (a host that resolved
 * publicly at registration can resolve privately today) and pinned for the
 * connection, redirects are refused, the body is re-signed with a fresh
 * timestamp, and the call is bounded by a timeout.
 */

import { Prisma } from '@prisma/client'
import { systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { decryptSecret } from '@/lib/crypto/secrets'
import { recordCredentialUse } from '@/lib/credentials/audit'
import { fetchPublicUrl, SsrfError } from '@/lib/net/ssrf'
import { PermanentOutboxError } from '@/lib/outbox'
import { recordLedgerEntry } from '@/lib/agents/action-ledger'
import { broadcastAgentEventTick } from '@/lib/flows/run-stream'
import { externalDeliveryHeaders } from './signing'
import { WAITING_FOR_EXTERNAL, webhookHostOf, type ExternalTaskPayload } from './types'

export type ExternalTaskOutboxPayload = { executionId: string; encryptedBody: string }

export function isExternalTaskPayload(value: unknown): value is ExternalTaskOutboxPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate.executionId === 'string' && typeof candidate.encryptedBody === 'string'
}

/** One attempt's ceiling. A receiver should acknowledge fast and work after. */
export const EXTERNAL_DELIVERY_TIMEOUT_MS = 10_000

type DeliveryDeps = { fetchImpl?: typeof fetch; now?: () => number }

function readTask(body: string): Partial<ExternalTaskPayload> {
  try {
    return JSON.parse(body) as Partial<ExternalTaskPayload>
  } catch {
    return {}
  }
}

/** What the ledger keeps about a task: enough to recognise it, never the token. */
export function taskLedgerArgs(task: Partial<ExternalTaskPayload>): Record<string, unknown> {
  return {
    task: task.task?.input ?? '',
    trigger: task.context?.trigger ?? null,
    requester: task.context?.requester?.displayName ?? null,
    ...(task.context?.slack ? { slackChannel: task.context.slack.channelId } : {}),
    ...(task.context?.flow ? { flow: task.context.flow.flowName ?? task.context.flow.flowId } : {}),
  }
}

async function recordDeliveryEvent(executionId: string, kind: string, payload: Record<string, unknown>) {
  // systemPrisma: WorkflowEvent carries no organizationId; the execution id was
  // resolved against the outbox row's organization by the caller.
  await systemPrisma.workflowEvent
    .create({ data: { executionId, kind, payload: payload as Prisma.InputJsonValue } })
    .catch(() => undefined)
  broadcastAgentEventTick(executionId)
}

export async function deliverExternalTask(
  organizationId: string,
  payload: ExternalTaskOutboxPayload,
  deps: DeliveryDeps = {},
): Promise<void> {
  // systemPrisma: outbox handler (worker/cron, no request tenant context); the
  // row is pinned to the outbox event's organization.
  const execution = await systemPrisma.agentExecution.findFirst({
    where: { id: payload.executionId, organizationId },
    select: { id: true, status: true, replyTokenHash: true, agentTaskId: true, userId: true },
  })
  // Settled already (replied, timed out, cancelled): nothing left to deliver.
  // A reply can legitimately land before the outbox marks this row delivered —
  // a fast agent answers inside the webhook call — so this is not an error.
  if (!execution || execution.status !== WAITING_FOR_EXTERNAL || !execution.replyTokenHash || !execution.agentTaskId) return

  // systemPrisma: same outbox context; pinned to the organization and agent.
  const external = await systemPrisma.externalAgent.findFirst({
    where: { agentTaskId: execution.agentTaskId, organizationId },
    select: { id: true, webhookUrl: true, signingSecretCiphertext: true },
  })
  if (!external) throw new PermanentOutboxError('The external agent was removed before its task could be delivered.')

  const host = webhookHostOf(external.webhookUrl)
  const body = decryptSecret(payload.encryptedBody)
  const secret = decryptSecret(external.signingSecretCiphertext)
  await recordCredentialUse({
    organizationId,
    kind: 'external_agent',
    credentialId: external.id,
    provider: host,
    actorUserId: execution.userId,
    executionId: execution.id,
    consumer: 'external_agent.delivery',
  })

  const markFailure = async (reason: string) => {
    // systemPrisma: id-keyed status write on the row loaded above.
    await systemPrisma.externalAgent
      .update({ where: { id: external.id }, data: { lastDeliveryAt: new Date(), lastDeliveryStatus: 'failed', lastDeliveryError: reason.slice(0, 300) } })
      .catch(() => undefined)
  }

  const nowSeconds = Math.floor((deps.now?.() ?? Date.now()) / 1000)
  let response: Response
  try {
    response = await fetchPublicUrl(
      external.webhookUrl,
      {
        method: 'POST',
        headers: externalDeliveryHeaders({ secret, body, executionId: execution.id, nowSeconds }),
        body,
        signal: AbortSignal.timeout(EXTERNAL_DELIVERY_TIMEOUT_MS),
      },
      // A redirect is refused outright: the signed body must reach the host
      // that was registered, not wherever it points next.
      { maxRedirects: 0, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
    )
  } catch (error) {
    if (error instanceof SsrfError) {
      const reason = `the webhook URL is not allowed (${error.message})`
      await markFailure(reason)
      throw new PermanentOutboxError(reason)
    }
    const reason = error instanceof Error && error.name === 'TimeoutError'
      ? `${host} did not answer within ${EXTERNAL_DELIVERY_TIMEOUT_MS / 1000} seconds`
      : `could not reach ${host} (${error instanceof Error ? error.message : String(error)})`
    await markFailure(reason)
    throw new Error(reason)
  }

  if (!response.ok) {
    const reason = `${host} answered HTTP ${response.status}`
    await markFailure(reason)
    await recordDeliveryEvent(execution.id, 'external.delivery_retry', { host, status: response.status })
    // 408 and 429 are "try again"; any other 4xx is the receiver saying no
    // (a rejected signature, a removed route), which retrying cannot change.
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429
    throw permanent ? new PermanentOutboxError(`${host} refused the task (HTTP ${response.status})`) : new Error(reason)
  }

  // systemPrisma: id-keyed status write on the row loaded above.
  await systemPrisma.externalAgent
    .update({ where: { id: external.id }, data: { lastDeliveryAt: new Date(), lastDeliveryStatus: 'delivered', lastDeliveryError: null } })
    .catch(() => undefined)
  await recordDeliveryEvent(execution.id, 'external.delivered', { host })
  await recordLedgerEntry(
    {
      organizationId,
      source: { kind: 'agent', agentTaskId: execution.agentTaskId, runId: execution.id },
      actorUserId: execution.userId,
      provider: `external:${host}`,
      plane: 'external',
      tool: 'task_sent',
      args: taskLedgerArgs(readTask(body)),
      isWrite: true,
    },
    { status: 'done', resultRef: { label: host, httpStatus: String(response.status) } },
  )
}

/**
 * The outbox gave up on a task (attempts exhausted, or a permanent refusal):
 * record it, and fail the waiting run with the reason through the normal
 * completion path.
 */
export async function externalDeliveryGaveUp(organizationId: string, payload: unknown, reason: string): Promise<void> {
  if (!isExternalTaskPayload(payload)) return
  // systemPrisma: outbox terminal hook; pinned to the event's organization.
  const execution = await systemPrisma.agentExecution.findFirst({
    where: { id: payload.executionId, organizationId },
    select: { id: true, status: true, agentTaskId: true, userId: true },
  })
  if (!execution || execution.status !== WAITING_FOR_EXTERNAL) return
  // systemPrisma: same outbox context.
  const external = execution.agentTaskId
    ? await systemPrisma.externalAgent.findFirst({ where: { agentTaskId: execution.agentTaskId, organizationId }, select: { webhookUrl: true } })
    : null
  const host = external ? webhookHostOf(external.webhookUrl) : 'the external agent'
  let task: Partial<ExternalTaskPayload> = {}
  try {
    task = readTask(decryptSecret(payload.encryptedBody))
  } catch {
    task = {}
  }
  await recordLedgerEntry(
    {
      organizationId,
      source: { kind: 'agent', agentTaskId: execution.agentTaskId, runId: execution.id },
      actorUserId: execution.userId,
      provider: `external:${host}`,
      plane: 'external',
      tool: 'task_sent',
      args: taskLedgerArgs(task),
      isWrite: true,
    },
    { status: 'failed', error: reason },
  )
  await recordDeliveryEvent(execution.id, 'external.delivery_failed', { host, reason: reason.slice(0, 300) })
  const { settleExternalExecution, kickSettle } = await import('./settle')
  const settled = await settleExternalExecution({
    organizationId,
    executionId: execution.id,
    reply: { status: 'failed', output: `Couldn't deliver the task to ${host}: ${reason}.`, links: [], source: 'delivery' },
  })
  if (settled) await kickSettle(settled)
  apiLogger.warn('external agent delivery gave up', { organizationId, executionId: execution.id, host, reason })
}
