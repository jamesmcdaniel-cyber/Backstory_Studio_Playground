import { nangoApiError } from '@/lib/nango/errors'
import { syncOrgNangoConnections } from '@/lib/nango/mirror'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { MIN_INTEGRATIONS_FOR_TEMPLATES } from '@/lib/integrations/integration-count'
import { maybeGenerateOnGateClear } from '@/lib/templates/generation-queue'

export const runtime = 'nodejs'

// Lists the organization's Nango connections (live from Nango) and mirrors them
// into the per-org nango_connections table. Nango owns the credentials; we only
// persist connection ids and health. The mirror is also kept fresh by the Nango
// webhook (see /api/nango/webhook) so headless agent runs don't depend on this
// page being opened.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  try {
    const connections = await syncOrgNangoConnections(auth.organizationId)
    // "Learn the moment they qualify": the grid calls this right after a connect
    // (refreshStatus). Once the org plausibly meets the integration gate, kick a
    // debounced generation check so first recommendations don't wait for the
    // daily cron. Guarded on count so below-gate views stay cheap; best-effort,
    // never blocks the response; internally debounced + usage-gated.
    if (Object.keys(connections).length >= MIN_INTEGRATIONS_FOR_TEMPLATES) {
      void maybeGenerateOnGateClear(auth.organizationId).catch(() => undefined)
    }
    return { success: true, connections }
  } catch (error) {
    throw nangoApiError(error)
  }
}, { permission: 'flow.read' })
