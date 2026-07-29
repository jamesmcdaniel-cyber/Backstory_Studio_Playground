import { withAuthenticatedApi, ApiError } from '@/lib/server/api-handler'
import { getProposal, markDismissed } from '@/lib/templates/proposals'

// POST /api/template-proposals/[id]/dismiss — terminal, idempotent, org-scoped.
// A missing/other-org proposal 404s; an already-terminal one returns its current
// status unchanged (markDismissed only flips open → dismissed).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Proposal id is required')

  const proposal = await getProposal(id, auth.organizationId)
  if (!proposal) throw new ApiError('Proposal not found', 404, 'NOT_FOUND')

  if (proposal.status !== 'open') return { status: proposal.status }

  await markDismissed(id, auth.organizationId)
  return { status: 'dismissed' }
}, { permission: 'template.author' })
