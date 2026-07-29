import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'

export const runtime = 'nodejs'

/** Resolve the agent id from the path and enforce visibility. */
async function requireAgent(request: Request, auth: { organizationId: string; dbUser: { id: string } }) {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Agent id is required')
  const agent = await prisma.agentTask.findFirst({
    where: { id, organizationId: auth.organizationId, status: { not: 'DELETED' }, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!agent) throw new ApiError('Agent not found', 404, 'NOT_FOUND')
  return agent.id
}

// GET — list this agent's memories (optionally filtered by kind/status).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const agentId = await requireAgent(request, auth)
  const kind = request.nextUrl.searchParams.get('kind') ?? undefined
  const status = request.nextUrl.searchParams.get('status') ?? undefined
  const [memories, openSuggestions] = await Promise.all([
    prisma.agentMemory.findMany({
      where: {
        organizationId: auth.organizationId,
        agentId,
        ...(kind ? { kind } : {}),
        ...(status ? { status } : { status: { not: 'superseded' } }),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        kind: true,
        title: true,
        content: true,
        question: true,
        status: true,
        timesUsed: true,
        lastUsedAt: true,
        sourceExecutionId: true,
        createdAt: true,
      },
    }),
    prisma.agentMemory.count({
      where: { organizationId: auth.organizationId, agentId, kind: 'suggestion', status: 'open' },
    }),
  ])
  return { success: true, memories, openSuggestions }
}, { permission: 'agent.read' })

// PATCH — dismiss or restore a suggestion.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const agentId = await requireAgent(request, auth)
  const { id, status } = z.object({ id: z.string(), status: z.enum(['dismissed', 'open']) }).parse(await request.json())
  const updated = await prisma.agentMemory.updateMany({
    where: { id, organizationId: auth.organizationId, agentId },
    data: { status },
  })
  if (updated.count !== 1) throw new ApiError('Memory not found', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'agent.write' })

// DELETE — remove one memory, or all of this agent's memories.
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const agentId = await requireAgent(request, auth)
  const body = z.object({ id: z.string().optional(), all: z.boolean().optional() }).parse(await request.json().catch(() => ({})))
  if (!body.id && !body.all) throw new ApiError('Provide id or all')
  const deleted = await prisma.agentMemory.deleteMany({
    where: {
      organizationId: auth.organizationId,
      agentId,
      ...(body.all ? {} : { id: body.id }),
    },
  })
  return { success: true, deleted: deleted.count }
}, { permission: 'agent.write' })
