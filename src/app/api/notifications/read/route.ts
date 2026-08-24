import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { unreadNotificationScope } from '@/lib/notifications/scope'

/**
 * Mark notifications read — all visible unread, or a specific set of ids.
 *
 * `clear: true` additionally empties the panel by stamping the reader's
 * watermark (see src/lib/notifications/scope.ts). Read and cleared are
 * genuinely different states: opening the bell marks things read (the badge
 * goes quiet, the list stays), while clearing is the person saying they are
 * done with these — so the read sweep runs either way and the stamp is the
 * extra step.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { ids, clear } = z
    .object({ ids: z.array(z.string()).optional(), clear: z.boolean().optional() })
    .parse(await request.json().catch(() => ({})))

  if (clear && ids?.length) {
    throw new ApiError('Clear empties the whole panel — it cannot be limited to ids.', 400, 'NOTIFICATION_CLEAR_ARGS')
  }

  await prisma.notification.updateMany({
    where: {
      ...unreadNotificationScope(auth.organizationId, auth.dbUser.id, auth.dbUser.notificationsClearedAt),
      ...(ids && ids.length ? { id: { in: ids } } : {}),
    },
    data: { readAt: new Date() },
  })

  if (clear) {
    // Writing the User row evicts this person's cached auth row (see
    // auth-cache.ts), so the very next request reads the new watermark rather
    // than serving the list it just cleared.
    await prisma.user.update({
      where: { id: auth.dbUser.id },
      data: { notificationsClearedAt: new Date() },
    })
  }
  return { success: true, cleared: Boolean(clear) }
}, { permission: null })
