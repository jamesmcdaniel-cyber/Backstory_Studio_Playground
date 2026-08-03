import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { DeleteConflictError, deleteUserAccount } from '@/lib/privacy/delete'

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { confirmation } = z.object({ confirmation: z.string() }).parse(await request.json())
  if (confirmation.trim().toLowerCase() !== (auth.dbUser.email ?? '').trim().toLowerCase()) {
    throw new ApiError('Type your email address to confirm account deletion.', 400, 'CONFIRMATION_REQUIRED')
  }
  try {
    await deleteUserAccount({ userId: auth.dbUser.id, supabaseId: auth.dbUser.supabaseId, organizationId: auth.organizationId, email: auth.dbUser.email, role: auth.dbUser.role })
  } catch (error) {
    if (error instanceof DeleteConflictError) throw new ApiError(error.message, 409, 'OWNERSHIP_TRANSFER_REQUIRED')
    throw error
  }
  return { success: true }
}, { permission: null, skipBackstoryGate: true, skipEntitlementGate: true })
