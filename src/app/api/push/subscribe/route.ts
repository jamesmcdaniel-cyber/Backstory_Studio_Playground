import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { endpoint, keys } = z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }).parse(await request.json())

  await prisma.pushSubscription.upsert({
    where: { endpoint },
    create: {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userId: auth.dbUser.id,
      organizationId: auth.organizationId,
    },
    update: { p256dh: keys.p256dh, auth: keys.auth, userId: auth.dbUser.id },
  })
  return { success: true }
}, { permission: null })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const endpoint = request.nextUrl.searchParams.get('endpoint')
  if (endpoint) {
    await prisma.pushSubscription.deleteMany({ where: { organizationId: auth.organizationId, endpoint, userId: auth.dbUser.id } })
  }
  return { success: true }
}, { permission: null })
