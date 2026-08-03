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
  if (members === 1) {
    await teardownOrganization(params.organizationId)
  } else {
    await getGraphRagStore().deleteByOwner(params.organizationId, params.userId).catch(() => undefined)
    await systemPrisma.user.delete({ where: { id: params.userId } })
  }
  await admin.deleteUser(params.supabaseId).catch(() => undefined)
}
