import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'

/**
 * Teammates are the avatars on the agents roster: one named persona owning a
 * group of agents that do different jobs. The gallery reads this list, and the
 * template installer writes to it (installing into an existing teammate instead
 * of spawning a standalone agent).
 *
 * Agent membership is not returned here — the gallery already holds the agent
 * list from /api/snapshot and groups it by `teammateId`, so duplicating the
 * roster would just be two sources that can disagree.
 */

const nameSchema = z.string().trim().min(1).max(60)

function serializeTeammate(teammate: {
  id: string
  name: string
  roleLabel: string | null
  avatarSeed: string | null
  createdAt: Date
}) {
  return {
    id: teammate.id,
    name: teammate.name,
    roleLabel: teammate.roleLabel,
    avatarSeed: teammate.avatarSeed,
    createdAt: teammate.createdAt,
  }
}

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const teammates = await prisma.agentTeammate.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'asc' },
    take: 300,
  })
  return { success: true, teammates: teammates.map(serializeTeammate) }
}, { permission: 'agent.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const { name, agentIds } = z
    .object({ name: nameSchema, agentIds: z.array(z.string().min(1)).max(100).optional() })
    .parse(await request.json())

  const teammate = await prisma.agentTeammate.create({
    data: { organizationId: auth.organizationId, name },
  })
  // Optional: adopt existing agents in the same call, so "group these under a
  // new teammate" is one request rather than a create plus N edits.
  if (agentIds?.length) {
    await prisma.agentTask.updateMany({
      where: {
        id: { in: agentIds },
        organizationId: auth.organizationId,
        status: { not: 'DELETED' },
        ...agentVisibilityScope(auth.dbUser.id),
      },
      data: { teammateId: teammate.id },
    })
  }
  return { success: true, teammate: serializeTeammate(teammate) }
}, { permission: 'agent.write' })

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const { id, name, avatarSeed } = z
    .object({
      id: z.string().min(1),
      name: nameSchema.optional(),
      // null clears the override, restoring the id-derived face.
      avatarSeed: z.string().trim().max(120).nullish(),
    })
    .parse(await request.json())
  const result = await prisma.agentTeammate.updateMany({
    where: { id, organizationId: auth.organizationId },
    // A rename or a new face changes what the avatar is CALLED or LOOKS LIKE,
    // not what its agents do, so the AI role label deliberately survives both.
    data: {
      ...(name !== undefined && { name }),
      ...(avatarSeed !== undefined && { avatarSeed: avatarSeed || null }),
    },
  })
  if (!result.count) throw new ApiError('Teammate not found', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'agent.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  // The FK is ON DELETE SET NULL: the agents survive and return to the roster
  // as solo cards. Disbanding an avatar must never delete the work it did.
  const result = await prisma.agentTeammate.deleteMany({
    where: { id, organizationId: auth.organizationId },
  })
  if (!result.count) throw new ApiError('Teammate not found', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'agent.write' })
