import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { pollIdentityChanged } from '@/lib/flows/trigger'
import { apiLogger } from '@/lib/logger'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { prepareToolArgs } from './tool-args'
import { flowToolOutput } from './tool-output'
import { pageItems } from '@/lib/flows/http-pagination'
import { newPollItems, pollItemKey, type PollCursor } from '@/lib/flows/poll'
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
  const cursor = storedPollCursor(flow.pollCursor)

  // A poll that cannot run (a write tool, one held for approval, a connection
  // that is gone, the server erroring) used to leave only a server log line, so
  // a published flow just never fired and nobody could see why. The failure is
  // now kept on the cursor where the builder reads it (pollFailure in poll.ts), and the
  // check is stamped so it retries on its cadence rather than every tick. The
  // seen keys are kept, so a transient failure doesn't turn into a re-baseline.
  const recordFailure = async (message: string) => {
    apiLogger.warn('runFlowPoll: poll failed', { flowId: flow.id, toolName, error: message })
    await persistPollCursor(flow, {
      ...(cursor ? { seen: cursor.seen } : {}),
      lastPolledAt: now.toISOString(),
      lastError: { message: message.slice(0, MAX_POLL_ERROR_LENGTH), at: now.toISOString() },
    })
    return { dispatched: 0 }
  }

  let result: unknown
  try {
    result = await callPollTool(flow, trigger, connectionId, toolName, userId)
  } catch (error) {
    return recordFailure(error instanceof Error ? error.message : String(error))
  }
  if (result === WRITE_TOOL) {
    return recordFailure(`${toolName} changes things, and a polling trigger only runs read actions — pick a read action (e.g. list or search) and publish again.`)
  }

  const items = pageItems(result, typeof trigger.itemsPath === 'string' ? trigger.itemsPath : undefined)
  const dedupeKeyField = String(trigger.dedupeKey || 'id')
  const { fresh, nextCursor } = newPollItems(items, dedupeKeyField, cursor)

  // Dispatch first, then persist the cursor — at-least-once, so a crash between
  // the two re-emits (a downstream dedupe is cheaper than silently losing an
  // item). The batch mode starts the flow once with all new items as input.
  //
  // That re-emit is what `dedupeValue` covers: the run carries the item's
  // identity, so runScopeKey scopes its side-effect ledger by the ITEM rather
  // than the run id, and a second run for the same item REPLAYS its writes
  // instead of firing them again. The "downstream dedupe" this comment has
  // always promised is now real.
  if (trigger.emit === 'batch') {
    if (fresh.length) {
      await dispatchFlowExecution({
        flowId: flow.id,
        organizationId: flow.organizationId,
        userId,
        input: fresh,
        usePublished: true,
        // No dedupeValue: a batch has no single item to key on, so it falls
        // back to run-scoped keys (today's behavior).
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
        trigger: { type: 'poll', dedupeValue: pollItemKey(item, dedupeKeyField) },
      })
    }
  }

  // Written without lastError: a successful check clears the failure notice.
  await persistPollCursor(flow, { ...nextCursor, lastPolledAt: now.toISOString() })
  return { dispatched: trigger.emit === 'batch' ? (fresh.length ? 1 : 0) : fresh.length }
}

const MAX_POLL_ERROR_LENGTH = 500

/**
 * Store the cursor this poll computed — unless the flow's trigger was
 * republished onto a different read while the poll ran. Publishing a new poll
 * read drops the cursor (trigger-columns.ts) so it baselines; writing back the
 * OLD read's seen keys after that would make the new read's every record look
 * fresh. Guarded on the trigger the poll used; a trigger that moved on with the
 * same read (a secret minted, a republish of other steps) still gets it.
 */
async function persistPollCursor(flow: PollFlow, pollCursor: Prisma.InputJsonValue) {
  const where = { id: flow.id, organizationId: flow.organizationId }
  const written = await prisma.flow.updateMany({
    where: { ...where, trigger: { equals: (flow.trigger ?? {}) as Prisma.InputJsonValue } },
    data: { pollCursor },
  })
  if (written.count) return
  const current = await prisma.flow.findFirst({ where, select: { trigger: true } })
  if (!current || pollIdentityChanged(flow.trigger, current.trigger)) return
  await prisma.flow.updateMany({ where, data: { pollCursor } })
}
const WRITE_TOOL = Symbol('write tool')

/** Call the trigger's read tool; WRITE_TOOL when it turns out to be a write. */
async function callPollTool(
  flow: PollFlow,
  trigger: PollTrigger,
  connectionId: string,
  toolName: string,
  userId: string,
): Promise<unknown> {
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

  const { plane, ref } = parseFlowToolConnectionId(connectionId)
  // The args go in so a tool classified per call (a warehouse SELECT) can be
  // polled while the same tool running a DELETE cannot. No `approval`: a poll
  // cannot stop for a person, so a tool held for approval is refused (throws).
  const executor = await resolveFlowToolExecutor({ organizationId: flow.organizationId, userId, plane, ref, toolName, args })
  // Never poll a WRITE tool — polling calls the tool every tick with no approval
  // gate, so it must be read-only.
  if (executor.isWrite) return WRITE_TOOL
  return flowToolOutput(await executor.execute(toolName, args))
}

/**
 * The dedupe cursor off the stored JSON, or undefined (→ the next poll is a
 * baseline). A row holding only a failure marker has no seen keys yet, and
 * must baseline rather than treat every record as new.
 */
function storedPollCursor(raw: unknown): PollCursor | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const seen = (raw as { seen?: unknown }).seen
  return Array.isArray(seen) ? { seen: seen.filter((key): key is string => typeof key === 'string') } : undefined
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
