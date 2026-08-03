import { systemPrisma } from '@/lib/prisma'
import { teardownOrganization } from '@/lib/org-teardown'
import { getGraphRagStore } from '@/lib/rag/get-store'
import { supabaseAdmin } from '@/lib/scim/server'

export class DeleteConflictError extends Error {}

export async function deleteUserAccount(params: { userId: string; supabaseId: string; organizationId: string; email: string | null; role: string }) {
  // Resolve credentials before making the irreversible database change.
  const admin = supabaseAdmin()
  const members = await systemPrisma.user.count({ where: { organizationId: params.organizationId, isActive: true } })
  if (params.role === 'OWNER' && members > 1) {
    throw new DeleteConflictError('Transfer workspace ownership before deleting this account.')
  }
  // Remove the identity first and require the provider to acknowledge it. A
  // successful response must never leave login PII behind at the auth system.
  const identity = await admin.deleteUser(params.supabaseId)
  if (identity.error) throw identity.error
  if (members === 1) {
    await teardownOrganization(params.organizationId)
  } else {
    await getGraphRagStore().deleteByOwner(params.organizationId, params.userId)
    await systemPrisma.user.delete({ where: { id: params.userId } })
  }
}
