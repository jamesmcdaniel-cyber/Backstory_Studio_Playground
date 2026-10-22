import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { entryVisibleTo } from '@/lib/agents/action-ledger-query'
import { UndoRefusedError, undoAgentAction } from '@/lib/agents/action-undo'

export const runtime = 'nodejs'

/**
 * POST /api/agent-actions/[id]/undo — reverse one ledger entry through its
 * provider's compensating action, as the person asking. Idempotent: undoing an
 * entry that is already undone answers success without calling the provider.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2) || ''
  const viewer = { organizationId: auth.organizationId, userId: auth.dbUser.id, canManageIntegrations: auth.can('integration.manage') }
  const entry = await prisma.agentAction.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { agentTaskId: true, flowId: true, runId: true },
  })
  if (!entry || !(await entryVisibleTo(viewer, entry))) throw new ApiError('Action not found', 404, 'NOT_FOUND')
  try {
    const result = await undoAgentAction({
      organizationId: auth.organizationId,
      actionId: id,
      requesterUserId: auth.dbUser.id,
      canManageIntegrations: viewer.canManageIntegrations,
    })
    return { success: true, ...result }
  } catch (error) {
    if (error instanceof UndoRefusedError) throw new ApiError(error.message, error.status, error.code)
    throw error
  }
}, { permission: 'agent.run' })
