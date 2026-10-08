import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { organizationExportStream } from '@/lib/privacy/export'

export const runtime = 'nodejs'
export const maxDuration = 1800

export const GET = withAuthenticatedApi(async (_request, auth) => {
  // Exports are the expensive reads: a full-table scan serialized into one
  // response. One budget across every export route, per user.
  const limited = await rateLimit(`export:${auth.userId}`, { limit: 20, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many exports — wait a minute and try again.', 429, 'RATE_LIMITED')
  const date = new Date().toISOString().slice(0, 10)
  return new Response(organizationExportStream(auth.organizationId), {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="backstory-workspace-${date}.ndjson"`,
      'cache-control': 'private, no-store',
    },
  })
}, { permission: 'data.export' })
