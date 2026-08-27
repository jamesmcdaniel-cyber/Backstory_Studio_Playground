/**
 * Signal router: matches an inbound Signal against the org's active
 * SignalSubscriptions and starts one agent execution per match, exactly once.
 *
 * Idempotency: executions carry idempotencyKey = `${signalId}:${agentTaskId}`
 * with a unique index per org — a replayed webhook (same dedupeKey → same
 * signal) or a re-routed signal cannot double-fire an agent.
 *
 * The signal itself is injected as STRUCTURED context (input.signal), not
 * string-templated into the objective; the runtime includes it in the run's
 * input for the model and the run history.
 */

import { Prisma } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { inlineExecution } from '@/lib/queue/execution-mode'
import { createQueue, QUEUE_NAMES, workersEnabled } from '@/lib/queue/config'
import { indexSignal } from '@/lib/rag/indexer'
import { runAgentExecution } from '@/features/agents/execute-agent'
import { injectTraceContext } from '@/lib/observability/otel'

interface SignalShape {
  id: string
  organizationId: string
  type: string
  accountId: string | null
  opportunityId: string | null
  stakeholderId: string | null
  payload: unknown
}

/**
 * Shallow filter match: every filter key must equal the signal's value, looked
 * up in entity refs first, then the payload (and payload.data). Empty filter
 * matches everything.
 */
export function matchesFilter(signal: SignalShape, filter: unknown): boolean {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return true
  const entries = Object.entries(filter as Record<string, unknown>)
  if (entries.length === 0) return true

  const payload = (signal.payload && typeof signal.payload === 'object' ? signal.payload : {}) as Record<string, unknown>
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>
  const entityRefs: Record<string, unknown> = {
    accountId: signal.accountId,
    opportunityId: signal.opportunityId,
    stakeholderId: signal.stakeholderId,
    type: signal.type,
  }

  return entries.every(([key, expected]) => {
    const actual = entityRefs[key] ?? data[key] ?? payload[key]
    return String(actual) === String(expected)
  })
}

export type SignalDispatcher = (job: {
  executionId: string
  agentId: string
  organizationId: string
  userId: string
  input: string
}) => Promise<void>

/** Default dispatcher mirrors the webhook trigger path: inline or queued. */
const defaultDispatcher: SignalDispatcher = async (job) => {
  if (inlineExecution) {
    try {
      await runAgentExecution(job)
    } catch (error) {
      await prisma.agentExecution.update({
        where: { id: job.executionId, organizationId: job.organizationId },
        data: {
          status: 'failed',
          error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          completedAt: new Date(),
        },
      })
    }
    return
  }
  if (!workersEnabled) throw new Error('Agent worker is disabled')
  const queue = createQueue(QUEUE_NAMES.AGENT_EXECUTION)
  await queue.add('execute-agent', injectTraceContext(job), { jobId: job.executionId })
}

export interface RouteResult {
  matched: number
  started: number
  skippedDuplicates: number
}

export async function routeSignal(
  signalId: string,
  dispatcher: SignalDispatcher = defaultDispatcher,
): Promise<RouteResult> {
  // systemPrisma: internal chaining — routeSignal is called with only the signal
  // id (minted org-scoped by the webhook route); this read discovers organizationId.
  const signal = await systemPrisma.signal.findUnique({ where: { id: signalId } })
  if (!signal) return { matched: 0, started: 0, skippedDuplicates: 0 }

  const subscriptions = await prisma.signalSubscription.findMany({
    where: { organizationId: signal.organizationId, signalType: signal.type, isActive: true },
    include: { agentTask: { select: { id: true, status: true, objective: true, userId: true, organizationId: true, agentType: true, description: true, metadata: true } } },
  })

  const matches = subscriptions.filter(
    (subscription) => subscription.agentTask?.status === 'ACTIVE' && matchesFilter(signal, subscription.filter),
  )

  let started = 0
  let skippedDuplicates = 0

  for (const subscription of matches) {
    const agent = subscription.agentTask!
    // Attribute the run to the agent owner; fall back to the org's oldest
    // active member (same policy as webhook triggers).
    const owner = agent.userId
      ? await prisma.user.findFirst({ where: { id: agent.userId, organizationId: signal.organizationId, isActive: true } })
      : null
    const user =
      owner ||
      (await prisma.user.findFirst({
        where: { organizationId: signal.organizationId, isActive: true },
        orderBy: { createdAt: 'asc' },
      }))
    if (!user) continue

    let execution
    try {
      execution = await prisma.agentExecution.create({
        data: {
          agentType: agent.agentType,
          agentTaskId: agent.id,
          status: 'pending',
          idempotencyKey: `${signal.id}:${agent.id}`,
          signalId: signal.id,
          input: {
            prompt: agent.objective,
            signal: {
              id: signal.id,
              type: signal.type,
              accountId: signal.accountId,
              opportunityId: signal.opportunityId,
              stakeholderId: signal.stakeholderId,
              payload: signal.payload as Prisma.InputJsonValue,
            },
          } as Prisma.InputJsonObject,
          trigger: { type: 'signal', signalId: signal.id, subscriptionId: subscription.id },
          metadata: { title: `${signal.type} — ${agent.description ?? agent.id}` },
          userId: user.id,
          organizationId: signal.organizationId,
        },
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        skippedDuplicates++
        continue
      }
      throw error
    }

    await dispatcher({
      executionId: execution.id,
      agentId: agent.id,
      organizationId: signal.organizationId,
      userId: user.id,
      input: agent.objective,
    })
    started++
  }

  await prisma.signal.update({
    where: { id: signal.id, organizationId: signal.organizationId },
    data: { processedAt: new Date() },
  })

  // Index the signal + its entities into the graph-RAG store (best-effort,
  // gated on embeddings) so agents and the assistant can correlate against it.
  void indexSignal({
    id: signal.id,
    organizationId: signal.organizationId,
    type: signal.type,
    accountId: signal.accountId,
    opportunityId: signal.opportunityId,
    stakeholderId: signal.stakeholderId,
    payload: signal.payload,
  }).catch(() => undefined)

  apiLogger.info('signal routed', {
    signalId: signal.id,
    type: signal.type,
    matched: matches.length,
    started,
    skippedDuplicates,
  })

  return { matched: matches.length, started, skippedDuplicates }
}
