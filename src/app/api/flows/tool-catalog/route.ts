import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'

export const runtime = 'nodejs'

// GET /api/flows/tool-catalog — the org's MCP connections with their callable
// tools, for the flow builder's deterministic tool-step picker. Discovery is
// best-effort per connection: one unreachable server doesn't empty the list.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const catalog = await loadFlowToolCatalog(auth.organizationId, { userId: auth.dbUser.id, takeConnections: 25, takeTools: 100 })
  return { success: true, connections: catalog }
}, { permission: 'flow.read' })
