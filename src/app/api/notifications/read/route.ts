import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

// Mark notifications read — all visible unread, or a specific set of ids.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const { ids } = z.object({ ids: z.array(z.string()).optional() })
    .parse(await request.json().catch(() => ({})))

  await prisma.notification.updateMany({
    where: {
      organizationId: auth.organizationId,
      OR: [{ userId: auth.dbUser.id }, { userId: null }],
      readAt: null,
      ...(ids && ids.length ? { id: { in: ids } } : {}),
    },
    data: { readAt: new Date() },
  })
  return { success: true }
}, { permission: null })
