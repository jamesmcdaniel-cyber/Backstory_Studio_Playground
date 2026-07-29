import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { listSkills } from '@/lib/skills/compose'

const skillSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  category: z.string().max(40).default('Community'),
  instructions: z.string().min(1).max(20000),
  tags: z.array(z.string().max(30)).max(10).default([]),
  integrations: z.array(z.string().max(60)).max(10).default([]),
})

function serializeShared(
  skill: {
    id: string
    name: string
    description: string
    category: string
    instructions: string
    tags: unknown
    integrations: unknown
    authorName: string
    organizationId: string
  },
  viewerOrgId: string,
) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    category: skill.category,
    audience: [] as string[],
    tags: Array.isArray(skill.tags) ? (skill.tags as string[]) : [],
    integrations: Array.isArray(skill.integrations) ? (skill.integrations as string[]) : [],
    authorName: skill.authorName,
    instructions: skill.instructions,
    custom: true,
    // Only the creating org may edit/delete its community skills.
    mine: skill.organizationId === viewerOrgId,
  }
}

// GET — built-in skills, this workspace's own skills at any visibility, and
// other workspaces' PUBLISHED ones. Mirrors fetchCatalogueRows: the published
// slice is the only cross-org read.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const own = await prisma.sharedSkill.findMany({
    where: { organizationId: auth.organizationId, isActive: true },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  // systemPrisma: the PUBLISHED community slice from OTHER orgs. Own rows come
  // from the tenant-guarded query above.
  const published = await systemPrisma.sharedSkill.findMany({
    where: { isActive: true, visibility: 'global', NOT: { organizationId: auth.organizationId } },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  })
  return {
    success: true,
    skills: [
      ...[...own, ...published].map((skill) => serializeShared(skill, auth.organizationId)),
      ...listSkills().map((skill) => ({ ...skill, custom: false, mine: false })),
    ],
  }
}, { permission: 'agent.read' })

// POST — create a skill in THIS workspace. It reaches the shared library only
// through review; visibility defaults to 'org' and is never taken from the body.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = skillSchema.parse(await request.json())
  const skill = await prisma.sharedSkill.create({
    data: {
      ...data,
      authorName: auth.dbUser.name || auth.dbUser.email || '',
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
    },
  })
  return { success: true, skill: serializeShared(skill, auth.organizationId) }
}, { permission: 'template.author' })

// PUT — edit your own community skill.
export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({ id: z.string().min(1) }).merge(skillSchema.partial()).parse(await request.json())
  const existing = await prisma.sharedSkill.findFirst({
    where: { id: body.id, organizationId: auth.organizationId, isActive: true },
  })
  if (!existing) throw new ApiError('Skill not found (you can only edit skills you published)', 404, 'NOT_FOUND')
  const { id, ...patch } = body
  // SECURITY FIX: the write itself was unscoped (relying only on the findFirst
  // ownership check above) — re-assert organizationId on the mutating query too.
  const skill = await prisma.sharedSkill.update({
    where: { id, organizationId: auth.organizationId },
    data: patch,
  })
  return { success: true, skill: serializeShared(skill, auth.organizationId) }
}, { permission: 'template.author' })

// DELETE — retract your own community skill (soft delete; agents referencing it
// simply stop composing it).
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const result = await prisma.sharedSkill.updateMany({
    where: { id, organizationId: auth.organizationId },
    data: { isActive: false },
  })
  if (!result.count) throw new ApiError('Skill not found (you can only remove skills you published)', 404, 'NOT_FOUND')
  return { success: true }
}, { permission: 'template.author' })
