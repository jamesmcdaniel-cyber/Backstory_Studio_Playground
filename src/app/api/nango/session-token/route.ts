import { z } from 'zod'
import { getNangoClient, NANGO_ORG_TAG } from '@/lib/nango/client'
import { nangoApiError } from '@/lib/nango/errors'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { checkIntegrationAllowance, limitMessage } from '@/lib/usage/free-tier-limits'

export const runtime = 'nodejs'

// Creates a Nango Connect session token for the signed-in user. The frontend
// passes the token to the Connect UI, which runs the OAuth flow end to end.
// Sessions are tagged with the organization id so connections stay org-scoped.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { integrationId } = z
    .object({ integrationId: z.string().min(1).optional() })
    .parse(await request.json().catch(() => ({})))

  // Refuse BEFORE minting a session token: letting the OAuth flow run and then
  // rejecting the mirrored connection would leave the user authorised at the
  // provider with nothing to show for it.
  const allowance = await checkIntegrationAllowance({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    canReview: auth.can('catalogue.review'),
    email: auth.dbUser.email,
  })
  if (allowance.over) {
    throw new ApiError(limitMessage('integration', allowance.limit), 429, 'INTEGRATION_LIMIT_REACHED')
  }

  try {
    const { data } = await getNangoClient().createConnectSession({
      end_user: {
        id: auth.dbUser.id,
        ...(auth.dbUser.email ? { email: auth.dbUser.email } : {}),
        ...(auth.dbUser.name ? { display_name: auth.dbUser.name } : {}),
      },
      organization: { id: auth.organizationId },
      tags: { [NANGO_ORG_TAG]: auth.organizationId, user_id: auth.dbUser.id },
      ...(integrationId ? { allowed_integrations: [integrationId] } : {}),
    })
    return { success: true, sessionToken: data.token, expiresAt: data.expires_at }
  } catch (error) {
    throw nangoApiError(error)
  }
}, { permission: 'integration.manage' })
