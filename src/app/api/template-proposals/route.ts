import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { listOpenProposals } from '@/lib/templates/proposals'

// GET /api/template-proposals — the open AI-proposal review queue for the
// onboarding surface: the caller's own proposals + org-wide (null-userId) ones,
// newest-first. Org-scoped (listOpenProposals carries organizationId).
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const proposals = await listOpenProposals(auth.organizationId, auth.dbUser.id)
  return { success: true, proposals }
}, { permission: 'agent.read' })
