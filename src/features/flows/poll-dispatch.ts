import { prisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { prepareToolArgs } from './tool-args'
import { flowToolOutput } from './tool-output'
import { pageItems } from '@/lib/flows/http-pagination'
import { newPollItems, type PollCursor } from '@/lib/flows/poll'
import { dispatchFlowExecution } from './execute-flow'

type PollFlow = {
  id: string
  organizationId: string
  trigger: unknown
  pollCursor: unknown
}

type PollTrigger = {
  connectionId?: string
  toolName?: string
  args?: unknown
  itemsPath?: string
  dedupeKey?: string
  emit?: 'perItem' | 'batch'
}

/**
 * Run one poll for a flow whose trigger is `poll`: call the configured READ tool
 * from the catalog, find items new since the last poll (deduped by key against
 * the flow's cursor), and start the flow for each new item (or once with the
 * whole batch). The first poll only baselines the cursor and emits nothing.
 *
 * This is the plane-model advantage: ONE generic polling trigger works with
 * every read tool across every plane, where n8n needs a dedicated trigger node
 * per service.
 */
export async function runFlowPoll(flow: PollFlow, userId: string, now: Date): Promise<{ dispatched: number }> {
  const trigger = (flow.trigger && typeof flow.trigger === 'object' ? flow.trigger : {}) as PollTrigger
  const connectionId = String(trigger.connectionId || '')
  const toolName = String(trigger.toolName || '')
  if (!connectionId || !toolName) return { dispatched: 0 }

  const { plane, ref } = parseFlowToolConnectionId(connectionId)
  const executor = await resolveFlowToolExecutor({ organizationId: flow.organizationId, userId, plane, ref, toolName })
  // Never poll a WRITE tool — polling calls the tool every tick with no approval
  // gate, so it must be read-only.
  if (executor.isWrite) {
    apiLogger.warn('runFlowPoll: refusing to poll a write tool', { flowId: flow.id, toolName })
    return { dispatched: 0 }
  }

  let args: Record<string, unknown> = {}
  if (typeof trigger.args === 'string') {
    try {
      args = prepareToolArgs(JSON.parse(trigger.args))
    } catch {
      args = {}
    }
  } else if (trigger.args && typeof trigger.args === 'object') {
    args = prepareToolArgs(trigger.args)
  }

  const result = flowToolOutput(await executor.execute(toolName, args))
  const items = pageItems(result, typeof trigger.itemsPath === 'string' ? trigger.itemsPath : undefined)
  const cursor = (flow.pollCursor && typeof flow.pollCursor === 'object' ? flow.pollCursor : undefined) as PollCursor | undefined
  const { fresh, nextCursor } = newPollItems(items, String(trigger.dedupeKey || 'id'), cursor)

  // Dispatch first, then persist the cursor — at-least-once, so a crash between
  // the two re-emits (a downstream dedupe is cheaper than silently losing an
  // item). The batch mode starts the flow once with all new items as input.
  if (trigger.emit === 'batch') {
    if (fresh.length) {
      await dispatchFlowExecution({
        flowId: flow.id,
        organizationId: flow.organizationId,
        userId,
        input: fresh,
        usePublished: true,
        trigger: { type: 'poll' },
      })
    }
  } else {
    for (const item of fresh) {
      await dispatchFlowExecution({
        flowId: flow.id,
        organizationId: flow.organizationId,
        userId,
        input: item,
        usePublished: true,
        trigger: { type: 'poll' },
      })
    }
  }

  await prisma.flow.update({
    where: { id: flow.id, organizationId: flow.organizationId },
    data: { pollCursor: { ...nextCursor, lastPolledAt: now.toISOString() } },
  })
  return { dispatched: trigger.emit === 'batch' ? (fresh.length ? 1 : 0) : fresh.length }
}

/** Read the last-polled timestamp off a stored cursor (for schedule cadence). */
export function lastPolledAt(pollCursor: unknown): Date | null {
  if (pollCursor && typeof pollCursor === 'object') {
    const raw = (pollCursor as { lastPolledAt?: unknown }).lastPolledAt
    if (typeof raw === 'string') {
      const parsed = Date.parse(raw)
      if (!Number.isNaN(parsed)) return new Date(parsed)
    }
  }
  return null
}
