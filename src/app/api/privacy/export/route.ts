import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { organizationExportStream } from '@/lib/privacy/export'

export const runtime = 'nodejs'
export const maxDuration = 800

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const date = new Date().toISOString().slice(0, 10)
  return new Response(organizationExportStream(auth.organizationId), {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="backstory-workspace-${date}.ndjson"`,
      'cache-control': 'private, no-store',
    },
  })
}, { permission: 'data.export' })
