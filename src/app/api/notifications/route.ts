import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Notifications visible to the user: their own plus org-wide (userId null).
function scope(organizationId: string, userId: string) {
  return { organizationId, OR: [{ userId }, { userId: null }] }
}

export const GET = withAuthenticatedApi(async (request, auth) => {
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 30, 100)
  const where = scope(auth.organizationId, auth.dbUser.id)
  const [notifications, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.notification.count({ where: { ...where, readAt: null } }),
  ])
  return { success: true, notifications, unread }
}, { permission: null })
