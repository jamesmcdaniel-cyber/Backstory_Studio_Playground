import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { loadMcpConnectionPlaneGroups } from '@/features/agents/tool-planes'

// GET /api/mcp-connections/[id]/tools — the live tool list of one MCP
// connection, for the agent form's per-tool toggle popover. Rides the same
// cached discovery (10 min TTL per server URL) the agent runtime uses, so the
// list the user toggles is exactly the list a run would load.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Connection id is required')
  const [group] = await loadMcpConnectionPlaneGroups(auth.organizationId, auth.dbUser.id, { connectionIds: [id] })
  if (!group) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')
  if (group.toolsError) return { success: false as const, error: group.toolsError }
  return {
    success: true as const,
    items: group.tools.map((tool) => ({ name: tool.name, description: tool.description })),
  }
}, { permission: 'flow.read' })
