import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { registerExternalAgent } from '@/lib/agents/external/registry'
import { registerExternalAgentSchema } from '@/lib/agents/external/schemas'

export const runtime = 'nodejs'

/**
 * POST /api/agents/external — register an external agent: one running on
 * someone else's infrastructure, joining the roster as a teammate.
 *
 * `api.manage` (admins): registration mints an API key and starts sending
 * workspace content — whatever people ask the agent — to an endpoint outside
 * Backstory. The webhook is SSRF-checked here and again at every delivery.
 *
 * Returns the signing secret and the reply key's client secret ONCE.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = registerExternalAgentSchema.parse(await request.json())
  const { view, secrets } = await registerExternalAgent({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, input })
  return { success: true, externalAgent: view, secrets }
}, { permission: 'api.manage' })
