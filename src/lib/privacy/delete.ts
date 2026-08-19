import { systemPrisma } from '@/lib/prisma'
import { teardownOrganization } from '@/lib/org-teardown'
import { getGraphRagStore } from '@/lib/rag/get-store'
import { isIdentityGone, supabaseAdmin } from '@/lib/scim/server'
import { deprovisionUser } from '@/lib/revoke-user-access'
import { isPlatformOwnerEmail } from '@/lib/authz/platform-owner'

export class DeleteConflictError extends Error {}

export interface AccountDeletion {
  /** The Supabase identity was already gone, so there was nothing to erase. */
  identityMissing: boolean
  /** Their last workspace went with them. */
  workspaceDeleted: boolean
}

export async function deleteUserAccount(params: {
  userId: string
  supabaseId: string
  organizationId: string | null
  email: string | null
  role: string
  /** The operator, when this is an admin deletion rather than a self-serve one. */
  actorUserId?: string | null
}): Promise<AccountDeletion> {
  // The platform owner account is permanent — even a self-serve deletion
  // request is refused (the users-table trigger would abort it anyway).
  if (isPlatformOwnerEmail(params.email)) {
    throw new DeleteConflictError('The platform owner account cannot be deleted.')
  }
  // Resolve credentials before making the irreversible database change.
  const admin = supabaseAdmin()
  // Someone with no workspace has no colleagues to strand and no organization
  // to tear down, so the member arithmetic below does not apply to them — and
  // counting `organizationId: null` would count every such person at once.
  const members = params.organizationId
    ? await systemPrisma.user.count({ where: { organizationId: params.organizationId, isActive: true } })
    : 0
  if (params.role === 'OWNER' && members > 1) {
    throw new DeleteConflictError('Transfer workspace ownership before deleting this account.')
  }
  // Remove the identity first and require the provider to acknowledge it. A
  // successful response must never leave login PII behind at the auth system.
  //
  // "Already gone" acknowledges that just as well as "deleted". An identity
  // removed straight out of the Supabase dashboard leaves our row behind, and
  // treating the 404 as a failure is precisely what makes that orphan
  // permanent: the one row an operator most needs to clear becomes the one row
  // they cannot.
  const identity = await admin.deleteUser(params.supabaseId)
  const identityMissing = Boolean(identity.error) && isIdentityGone(identity.error)
  if (identity.error && !identityMissing) throw identity.error

  if (params.organizationId && members === 1) {
    // Teardown deletes each Nango connection upstream, fail-closed, as part of
    // erasing the workspace — so it needs no revocation pass of its own.
    await teardownOrganization(params.organizationId)
    return { identityMissing, workspaceDeleted: true }
  }

  if (params.organizationId) {
    // Revoke BEFORE the row disappears. Deleting the user cascades their
    // credential rows away, which erases our RECORD of each OAuth grant without
    // erasing the grant: the provider goes on honouring a token issued to an
    // account that no longer exists anywhere. Deprovisioning first is what
    // enqueues the upstream deletions.
    await deprovisionUser({
      userId: params.userId,
      organizationId: params.organizationId,
      reason: 'member_removed',
      actorUserId: params.actorUserId ?? params.userId,
    })
    await getGraphRagStore().deleteByOwner(params.organizationId, params.userId)
  }
  await systemPrisma.user.delete({ where: { id: params.userId } })
  return { identityMissing, workspaceDeleted: false }
}
