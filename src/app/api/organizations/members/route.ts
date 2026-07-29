import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Active members of the caller's workspace, for pickers (e.g. the flow
// builder's "Assign to" select on Request-information steps). Deliberately
// minimal — id + display fields only, no roles or avatars. Capped at 200;
// workspaces are small today and a picker doesn't need more. selfId lets
// callers that shouldn't offer the caller themselves (the Jam invite list)
// filter client-side without breaking pickers where self is valid.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const members = await prisma.user.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
    take: 200,
    select: { id: true, name: true, email: true, role: true },
  })
  return { success: true, members, selfId: auth.dbUser.id }
}, { permission: 'flow.read' })
