import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { listQuarantinedWork } from '@/lib/quarantine'

/**
 * Work stopped because its owner was deprovisioned.
 *
 * Gated on members.manage — the same permission that deprovisions someone, so
 * whoever can create this situation can also resolve it.
 */
export const GET = withAuthenticatedApi(
  async (_request, auth) => ({ items: await listQuarantinedWork(auth.organizationId) }),
  { permission: 'members.manage' },
)
