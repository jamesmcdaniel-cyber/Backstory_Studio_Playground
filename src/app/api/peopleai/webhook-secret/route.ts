import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { orgWebhookSecret, rotateOrgWebhookSecret } from '@/lib/peopleai/webhook-secret'

// Admin-only reveal/rotate of this org's People.ai webhook signing secret.
// Both handlers operate ONLY on the caller's own org (auth.organizationId) —
// there is no org id in the request, so this can never cross tenants.

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const secret = await orgWebhookSecret(auth.organizationId)
  return { success: true, secret, configured: Boolean(secret) }
}, { permission: 'org.manage' })

export const POST = withAuthenticatedApi(async (_request, auth) => {
  const secret = await rotateOrgWebhookSecret(auth.organizationId)
  return { success: true, secret }
}, { permission: 'org.manage' })
