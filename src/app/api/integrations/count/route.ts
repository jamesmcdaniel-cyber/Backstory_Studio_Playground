import { withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  MIN_INTEGRATIONS_FOR_TEMPLATES,
  meetsTemplateGate,
  summarizeConnectedIntegrations,
} from '@/lib/integrations/integration-count'

/**
 * GET /api/integrations/count
 *
 * The auto-template onboarding meter's read: how many DISTINCT integrations the
 * org has connected, the ≥3 threshold that unlocks AI template generation,
 * whether the gate is met, and the deduped providers behind the number.
 * Org+user scoped; the count and providers share the SAME dedupe as
 * countConnectedIntegrations (summarizeConnectedIntegrations), so they can't drift.
 */
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const { count, providers } = await summarizeConnectedIntegrations(auth.organizationId, auth.userId)

  return {
    connected: count,
    required: MIN_INTEGRATIONS_FOR_TEMPLATES,
    meetsGate: meetsTemplateGate(count),
    providers,
  }
}, { permission: 'flow.read' })
