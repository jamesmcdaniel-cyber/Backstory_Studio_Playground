import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { attachTargetNames, listOpenProposals } from '@/lib/templates/proposals'

// GET /api/template-proposals — the open AI-proposal review queue for the
// onboarding surface: the caller's own proposals + org-wide (null-userId) ones,
// newest-first. Org-scoped (listOpenProposals carries organizationId).
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const rows = await listOpenProposals(auth.organizationId, auth.dbUser.id)
  // Improvement rows are about a specific flow/agent; the surface leads with
  // that name rather than with the model's description of the fault.
  const proposals = await attachTargetNames(rows, auth.organizationId)
  return { success: true, proposals }
}, { permission: 'agent.read', internalOnly: true })
