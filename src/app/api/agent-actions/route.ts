import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { listLedgerEntries, visibleLedgerWhere } from '@/lib/agents/action-ledger-query'

export const runtime = 'nodejs'

/**
 * GET /api/agent-actions?agentId=… | ?flowId=… | ?runId=…  [&cursor=…&take=…]
 *
 * The action ledger — every side-effecting tool call an agent or flow made —
 * for one agent, one flow, or one run. Visibility follows the agent/flow: a
 * private one's entries are its owner's alone. Each entry carries an undo
 * verdict for the person asking.
 */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const params = request.nextUrl.searchParams
  const filter = {
    agentId: params.get('agentId') || undefined,
    flowId: params.get('flowId') || undefined,
    runId: params.get('runId') || undefined,
  }
  if (!filter.agentId && !filter.flowId && !filter.runId) throw new ApiError('Pass an agentId, flowId or runId.')
  const viewer = { organizationId: auth.organizationId, userId: auth.dbUser.id, canManageIntegrations: auth.can('integration.manage') }
  const where = await visibleLedgerWhere(viewer, filter)
  if (!where) throw new ApiError('Not found', 404, 'NOT_FOUND')
  const take = Number(params.get('take'))
  const result = await listLedgerEntries(viewer, where, {
    take: Number.isFinite(take) && take > 0 ? take : undefined,
    cursor: params.get('cursor') || undefined,
  })
  return { success: true, ...result }
}, { permission: 'agent.read' })
