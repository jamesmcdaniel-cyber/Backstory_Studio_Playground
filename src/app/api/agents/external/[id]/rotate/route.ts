import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { rotateExternalAgentCredential } from '@/lib/agents/external/registry'
import { rotateExternalAgentSchema } from '@/lib/agents/external/schemas'

export const runtime = 'nodejs'

/**
 * POST /api/agents/external/[id]/rotate { credential: 'signing_secret' | 'api_key' }
 *
 * Replace the webhook signing secret (deliveries are signed with the new one
 * from the next attempt) or the reply key (the old key and every token minted
 * from it stop working at once). The new secret is returned once.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { credential } = rotateExternalAgentSchema.parse(await request.json())
  const agentId = request.nextUrl.pathname.split('/').at(-2) || ''
  const { view, secrets } = await rotateExternalAgentCredential({ organizationId: auth.organizationId, actorUserId: auth.dbUser.id, agentId, credential })
  return { success: true, externalAgent: view, secrets }
}, { permission: 'api.manage' })
