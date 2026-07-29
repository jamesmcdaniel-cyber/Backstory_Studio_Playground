import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { getAvailableIntegrations } from '@/lib/integrations/connected'

/**
 * GET /api/integrations/available
 *
 * Every tool the org can attach to an agent, unified across planes so the
 * create-agent form shows what's ACTUALLY configured (not just env builtins):
 *  - `tools`: a deduped, logo-tagged list merging built-ins (Slack/Email/
 *    Granola) and Nango-connected accounts.
 *    Each `key` is the string the agent runtime matches — both this endpoint
 *    and loadTools derive keys/matching from the shared connector registry, so
 *    a chip the UI shows is a chip the runtime activates.
 *  - `connections`: the org's custom Backstory-MCP connections (id + name),
 *    which the runtime loads for every agent regardless of selection.
 *
 * Connection state is read from the nango_connections mirror table — the same
 * source the runtime uses — so this stays a fast DB read with no external
 * Nango round-trips. The plane merge lives in
 * `@/lib/integrations/connected` (getAvailableIntegrations) so this endpoint
 * and the auto-template gate share one definition of "connected".
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const data = await getAvailableIntegrations(auth.organizationId)
  return { success: true, ...data }
}, { permission: 'flow.read' })
