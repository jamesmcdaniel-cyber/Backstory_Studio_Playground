import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { visibleNotificationScope, unreadNotificationScope } from '@/lib/notifications/scope'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const limit = Math.min(Number(request.nextUrl.searchParams.get('limit')) || 30, 100)
  const clearedAt = auth.dbUser.notificationsClearedAt
  const where = visibleNotificationScope(auth.organizationId, auth.dbUser.id, clearedAt)
  const [notifications, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.notification.count({ where: unreadNotificationScope(auth.organizationId, auth.dbUser.id, clearedAt) }),
  ])
  return { success: true, notifications, unread }
}, { permission: null })
