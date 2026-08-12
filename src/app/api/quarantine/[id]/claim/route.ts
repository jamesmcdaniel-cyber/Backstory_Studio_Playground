import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { claimQuarantinedWork } from '@/lib/quarantine'

const bodySchema = z.object({ kind: z.enum(['flow', 'agent']) })

/**
 * Take ownership of quarantined work. It resumes under the claimant's identity
 * and their credentials — the only attribution that is honest once the original
 * owner is gone.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2) ?? ''
  const { kind } = bodySchema.parse(await request.json())

  const claimed = await claimQuarantinedWork({
    organizationId: auth.organizationId,
    kind,
    id,
    claimantUserId: auth.dbUser.id,
  })
  // Already claimed, or never quarantined. Reported rather than silently
  // succeeding, so a race between two admins is visible to the second one.
  if (!claimed) throw new ApiError('That work is no longer waiting for an owner.', 409, 'NOT_QUARANTINED')

  return { success: true }
}, { permission: 'members.manage' })
