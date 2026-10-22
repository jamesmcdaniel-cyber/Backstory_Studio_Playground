import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { loadPublicLink, PublicLinkInputError, updatePublicLink } from '@/lib/flows/public-share'

export const runtime = 'nodejs'

function flowIdOf(request: Request): string {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required.', 400, 'ID_REQUIRED')
  return id
}

function originOf(request: Request): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(request.url).origin).replace(/\/$/, '')
}

// GET /api/flows/:id/public-link — the flow's public (no sign-in, view-only)
// link: whether it is on, the URL, its expiry, opens, and whether visitors may
// copy the flow. Same-org owner/editors only — the URL is the credential.
export const GET = withAuthenticatedApi(async (request, auth) => {
  return { success: true, ...(await loadPublicLink(auth.organizationId, flowIdOf(request), auth.dbUser.id, originOf(request))) }
}, { permission: 'flow.write' })

const bodySchema = z.object({
  action: z.enum(['enable', 'disable', 'rotate']).optional(),
  // When the link stops working; null = never.
  expiresAt: z.string().datetime().nullable().optional(),
  allowCopy: z.boolean().optional(),
})

// POST /api/flows/:id/public-link — turn the link on or off, rotate it (old
// URL stops working), set an expiry, or offer "Use this flow". Audited.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError(parsed.error.issues[0]?.message ?? 'Send action, expiresAt or allowCopy.', 400, 'INVALID_BODY')
  try {
    return { success: true, ...(await updatePublicLink(auth.organizationId, flowIdOf(request), auth.dbUser.id, originOf(request), parsed.data)) }
  } catch (error) {
    if (error instanceof PublicLinkInputError) throw new ApiError(error.message, 400, 'INVALID_PUBLIC_LINK')
    throw error
  }
}, { permission: 'flow.write' })
