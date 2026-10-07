import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { loadRoiPageSetup } from '@/lib/roi/page-setup'

export const runtime = 'nodejs'

// GET /api/roi/page — what the ROI analysis page needs: accounts with data
// (each with its report and this person's own page of it), the private admin
// agent behind the page, the data source, and the Backstory connection.
export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  setup: await loadRoiPageSetup({ organizationId: auth.organizationId, userId: auth.dbUser.id, role: auth.dbUser.role, canWriteAgents: auth.can('agent.write'), canLoadExtracts: auth.can('platform.administer') }),
}), { permission: 'agent.read', internalOnly: true })
