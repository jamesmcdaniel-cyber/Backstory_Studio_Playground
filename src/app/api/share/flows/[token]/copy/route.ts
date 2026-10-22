import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { copyPublicFlow } from '@/lib/flows/public-share'
import { rateLimit } from '@/lib/ratelimit'

export const runtime = 'nodejs'

// POST /api/share/flows/:token/copy — "Use this flow": copy the flow behind a
// public link (when its owner offers that) into the CALLER's workspace as a
// private draft. Credentials, workspace ids and pinned data are stripped, and
// nothing links the copy back to the original.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`flow-public-copy:${auth.organizationId}:${auth.dbUser.id}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Please wait a minute before trying again.', 429, 'RATE_LIMITED')
  const token = new URL(request.url).pathname.split('/').at(-2) ?? ''
  const result = await copyPublicFlow(token, { organizationId: auth.organizationId, userId: auth.dbUser.id })
  if (result.status === 'ok') return { success: true, flowId: result.flowId }
  if (result.status === 'expired') throw new ApiError('This link has expired.', 410, 'LINK_EXPIRED')
  if (result.status === 'not_offered') throw new ApiError('The owner of this flow has not offered copies.', 403, 'COPY_NOT_OFFERED')
  if (result.status === 'blocked') throw new ApiError('This flow has a credential typed into a step, so it cannot be copied. Ask its owner to move it into a saved credential.', 409, 'COPY_BLOCKED')
  throw new ApiError('This link is not available.', 404, 'NOT_FOUND')
}, { permission: 'flow.write' })
