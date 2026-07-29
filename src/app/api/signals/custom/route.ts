import type { CustomSignal } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

/**
 * Rep-defined custom signals: saved SalesAI questions reused here (People.ai
 * exposes no signal catalog). Per rep (owner) + org scoped. Running one lives at
 * /api/signals/custom/[id]/run.
 */

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  question: z.string().trim().min(1).max(2000),
  scope: z.enum(['account', 'opportunity']).default('account'),
})

function serialize(signal: CustomSignal) {
  return {
    id: signal.id,
    name: signal.name,
    question: signal.question,
    scope: signal.scope,
    updatedAt: signal.updatedAt,
  }
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const signals = await prisma.customSignal.findMany({
    where: { organizationId: auth.organizationId, userId: auth.dbUser.id },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  })
  return { success: true, signals: signals.map(serialize) }
}, { permission: 'agent.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  // Guard the parse: a bad/empty body should be a 400 (zod), not a 500.
  const data = createSchema.parse(await request.json().catch(() => ({})))
  const signal = await prisma.customSignal.create({
    data: {
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      name: data.name,
      question: data.question,
      scope: data.scope,
    },
  })
  return { success: true, signal: serialize(signal) }
}, { permission: 'agent.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).searchParams.get('id')
  if (!id) throw new ApiError('id is required')
  await prisma.customSignal.deleteMany({
    where: { id, organizationId: auth.organizationId, userId: auth.dbUser.id },
  })
  return { success: true }
}, { permission: 'agent.write' })
