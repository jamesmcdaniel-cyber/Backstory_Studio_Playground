import { z } from 'zod'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

const updateSchema = z.object({
  isActive: z.boolean().optional(),
  filter: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
})

function idFrom(request: NextRequest): string {
  return request.nextUrl.pathname.split('/').pop() || ''
}

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request)
  const existing = await prisma.signalSubscription.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true },
  })
  if (!existing) throw new ApiError('Subscription not found', 404, 'NOT_FOUND')

  const input = updateSchema.parse(await request.json())
  const subscription = await prisma.signalSubscription.update({
    where: { id, organizationId: auth.organizationId },
    data: { ...(input.isActive !== undefined && { isActive: input.isActive }), ...(input.filter !== undefined && { filter: input.filter }) },
  })
  return { success: true, subscription }
}, { permission: 'agent.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = idFrom(request)
  const result = await prisma.signalSubscription.deleteMany({
    where: { id, organizationId: auth.organizationId },
  })
  if (result.count === 0) throw new ApiError('Subscription not found', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'agent.write' })
