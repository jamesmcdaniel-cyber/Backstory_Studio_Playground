import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Active members of the caller's workspace, for pickers (e.g. the flow
// builder's "Assign to" select on Request-information steps). Deliberately
// minimal — id + display fields only, no avatars. Capped at 200; workspaces are
// small today and a picker doesn't need more. selfId lets callers that
// shouldn't offer the caller themselves (the Jam invite list) filter
// client-side without breaking pickers where self is valid.
//
// platformRole rides along because Settings → Members renders Super admin as
// the top rank of one role select, and it cannot show the current rank without
// knowing both stored columns. It is workspace-visible, like `role` already is.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const members = await prisma.user.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
    take: 200,
    select: { id: true, name: true, email: true, role: true, platformRole: true },
  })
  return { success: true, members, selfId: auth.dbUser.id }
}, { permission: 'flow.read' })
