/**
 * Undo one action-ledger entry.
 *
 * Runs as the person asking, through the SAME credential the write used: the
 * exact Nango connection recorded on the entry (or, for the native Slack
 * plane, the workspace bot). Who may do that:
 *
 *   - a personal connection → only its owner. An admin cannot reach into a
 *     colleague's account to reverse something, any more than an agent may act
 *     through one (the "agents act as user" invariant);
 *   - a workspace connection or bot → anyone holding `integration.manage`.
 *
 * Idempotent twice over: a claimed entry (done → undoing) is the race guard, so
 * two clicks run one compensator; and a provider answering "already gone"
 * (404/410, Slack message_not_found) counts as undone. Every attempt is
 * audited — `tool.undo` or `tool.undo_failed`.
 */

import { prisma } from '@/lib/prisma'
import { recordAudit } from '@/lib/audit'
import { describeUpstreamFailure } from '@/lib/upstream-error'
import { compensationFor, slackBotProxy, type ResultRef } from '@/lib/nango/compensators'
import { defaultProxy, type DeliveryConnection, type NangoProxy } from '@/lib/nango/delivery'
import { getSlackToken } from '@/lib/integrations/slack'

export class UndoRefusedError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'UNDO_REFUSED') {
    super(message)
    this.name = 'UndoRefusedError'
  }
}

type ConnectionRef = {
  actsAs?: string | null
  nango?: { connectionId?: string; providerConfigKey?: string; scope?: string }
}

/** The provider says the thing is already gone — the undo's goal is met. */
export function isAlreadyGone(error: unknown): boolean {
  const status = (error as { response?: { status?: number }; status?: number })?.response?.status ?? (error as { status?: number })?.status
  if (status === 404 || status === 410) return true
  const message = error instanceof Error ? error.message : String(error)
  return /\b(message_not_found|no_reaction|ENTITY_IS_DELETED)\b/.test(message)
}

export async function undoAgentAction(params: {
  organizationId: string
  actionId: string
  requesterUserId: string
  canManageIntegrations: boolean
  deps?: { proxy?: NangoProxy; slackToken?: (organizationId: string) => Promise<string | null> }
}): Promise<{ status: 'undone'; alreadyUndone: boolean; alreadyGone: boolean }> {
  const { organizationId, actionId, requesterUserId } = params
  const entry = await prisma.agentAction.findFirst({ where: { id: actionId, organizationId } })
  if (!entry) throw new UndoRefusedError('Action not found.', 404, 'NOT_FOUND')
  if (entry.status === 'undone') return { status: 'undone', alreadyUndone: true, alreadyGone: false }
  if (entry.status === 'undoing') throw new UndoRefusedError('This action is already being undone.', 409, 'UNDO_IN_PROGRESS')
  if (entry.status !== 'done') throw new UndoRefusedError("Only an action that completed can be undone — this one didn't go through.", 400, 'NOT_DONE')

  const compensation = compensationFor(entry)
  if (!compensation.undoable) throw new UndoRefusedError(`Can't be undone: ${compensation.reason}`, 400, 'NOT_UNDOABLE')
  const input = {
    args: {} as Record<string, unknown>,
    ref: (entry.resultRef ?? {}) as ResultRef,
    before: entry.beforeImage,
  }
  const missing = compensation.missing?.(input)
  if (missing) throw new UndoRefusedError(`Can't be undone: ${missing}`, 400, 'NOT_UNDOABLE')

  // Resolve the transport the write used, and check the requester may use it.
  const connectionRef = (entry.connectionRef ?? {}) as ConnectionRef
  let connection: DeliveryConnection
  let proxy: NangoProxy
  if (entry.provider.startsWith('nango:')) {
    const connectionId = connectionRef.nango?.connectionId
    const row = connectionId
      ? await prisma.nangoConnection.findFirst({ where: { organizationId, connectionId, status: 'connected' } })
      : null
    if (!row) throw new UndoRefusedError('The account this action went out on is no longer connected, so it can\'t be undone from here.', 409, 'CONNECTION_GONE')
    if (row.userId ? row.userId !== requesterUserId : !params.canManageIntegrations) {
      throw new UndoRefusedError(
        row.userId
          ? 'This was done through someone else\'s own account — only they can undo it.'
          : 'This was done through a workspace connection — undoing it needs permission to manage integrations.',
        403,
        'UNDO_FORBIDDEN',
      )
    }
    connection = { connectionId: row.connectionId, providerConfigKey: row.providerConfigKey, scope: row.userId ? 'user' : 'org' }
    proxy = params.deps?.proxy ?? defaultProxy()
  } else if (entry.provider === 'slack') {
    if (!params.canManageIntegrations) {
      throw new UndoRefusedError('This was posted by the workspace Slack bot — undoing it needs permission to manage integrations.', 403, 'UNDO_FORBIDDEN')
    }
    const token = params.deps?.slackToken ? await params.deps.slackToken(organizationId) : (await getSlackToken(organizationId))?.value ?? null
    if (!token) throw new UndoRefusedError('The workspace Slack bot is no longer connected, so this can\'t be undone from here.', 409, 'CONNECTION_GONE')
    connection = { connectionId: 'workspace-bot', providerConfigKey: 'slack', scope: 'org' }
    proxy = params.deps?.proxy ?? slackBotProxy(token)
  } else {
    throw new UndoRefusedError('No reverse action is known for this tool.', 400, 'NOT_UNDOABLE')
  }

  // Claim: exactly one caller runs the compensator.
  const claimed = await prisma.agentAction.updateMany({
    where: { id: entry.id, organizationId, status: 'done' },
    data: { status: 'undoing' },
  })
  if (claimed.count !== 1) {
    const current = await prisma.agentAction.findFirst({ where: { id: entry.id, organizationId }, select: { status: true } })
    if (current?.status === 'undone') return { status: 'undone', alreadyUndone: true, alreadyGone: false }
    throw new UndoRefusedError('This action is already being undone.', 409, 'UNDO_IN_PROGRESS')
  }

  let alreadyGone = false
  try {
    await compensation.undo(connection, input, proxy)
  } catch (error) {
    if (!isAlreadyGone(error)) {
      const message = describeUpstreamFailure(error)
      await prisma.agentAction.update({ where: { id: entry.id, organizationId }, data: { status: 'done', undoError: message.slice(0, 1000) } })
      await recordAudit({
        organizationId,
        executionId: entry.runId,
        actorUserId: requesterUserId,
        action: 'tool.undo_failed',
        tool: entry.tool,
        resourceType: 'agent_action',
        resourceId: entry.id,
        detail: { provider: entry.provider, error: message.slice(0, 300) },
      })
      throw new UndoRefusedError(`The undo didn't go through: ${message}`, 502, 'UNDO_FAILED')
    }
    alreadyGone = true
  }

  await prisma.agentAction.update({
    where: { id: entry.id, organizationId },
    data: { status: 'undone', undoneAt: new Date(), undoneById: requesterUserId, undoError: null },
  })
  await recordAudit({
    organizationId,
    executionId: entry.runId,
    actorUserId: requesterUserId,
    action: 'tool.undo',
    tool: entry.tool,
    resourceType: 'agent_action',
    resourceId: entry.id,
    detail: { provider: entry.provider, effect: compensation.effect, alreadyGone },
  })
  return { status: 'undone', alreadyUndone: false, alreadyGone }
}
