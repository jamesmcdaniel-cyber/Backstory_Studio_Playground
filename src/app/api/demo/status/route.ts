import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { resolveDemoOrganization } from '@/lib/demo/session'

export const runtime = 'nodejs'

// Whether this session is inside the demo sandbox — drives the sidebar chip.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const demoOrgId = await resolveDemoOrganization(auth.dbUser.id)
  return { success: true, active: Boolean(demoOrgId) }
}, { permission: 'flow.read' })
