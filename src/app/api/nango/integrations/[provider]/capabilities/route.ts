import { NextRequest } from 'next/server'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { integrationCapabilities } from '@/lib/integrations/capabilities'

export const runtime = 'nodejs'

// What this integration can read and do, straight from the tool registry the
// agents execute against — the card dialog's data source. The provider segment
// is a Nango config key; unknown keys return empty capability lists (honest
// "connectable, nothing wired yet"), not a 404.
export const GET = withAuthenticatedApi(async (request: NextRequest) => {
  const segments = request.nextUrl.pathname.split('/')
  const provider = decodeURIComponent(segments[segments.indexOf('integrations') + 1] ?? '')
  return { success: true, capabilities: integrationCapabilities(provider) }
})
