import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma, systemPrisma, tenantTransaction } from '@/lib/prisma'
import { hashToken } from '@/lib/crypto/secrets'
import { ApiError } from '@/lib/server/api-handler'
import { TEMPLATE_COPILOT_INSTRUCTIONS, TEMPLATE_COPILOT_MODEL } from './template-policy'

/** Explicit bearer-token export of published source only, into the caller's tenant. */
export async function useArtifactTemplate(token: string, organizationId: string, userId: string) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) throw new ApiError('Template not available.', 404, 'NOT_FOUND')
  // systemPrisma: cross-tenant access is restricted to this opted-in public
  // token. Never fetch source agent/config/chat/app state or private history.
  const source = await systemPrisma.artifact.findFirst({
    where: { shareTokenDigest: hashToken(token), shareAnonymous: true, shareTemplate: true, archivedAt: null, templateSourceId: null },
    select: { id: true, organizationId: true, currentVersionId: true, title: true, kind: true },
  })
  if (!source?.currentVersionId) throw new ApiError('Template not available.', 404, 'NOT_FOUND')
  const where = { organizationId, userId, templateSourceId: source.id }
  const existing = await prisma.artifact.findFirst({ where, select: { id: true } })
  if (existing) return existing
  const version = await systemPrisma.artifactVersion.findFirst({
    where: {
      id: source.currentVersionId, artifactId: source.id, organizationId: source.organizationId,
      artifact: { shareTokenDigest: hashToken(token), shareAnonymous: true, shareTemplate: true, archivedAt: null, currentVersionId: source.currentVersionId },
    },
    select: { content: true },
  })
  if (!version) throw new ApiError('The template changed. Reload its link and try again.', 409, 'TEMPLATE_CHANGED')
  try {
    return await tenantTransaction(organizationId, async tx => {
      const id = randomUUID()
      const versionId = randomUUID()
      const agent = await tx.agentTask.create({ data: {
        organizationId, userId, artifactTemplateCopyId: id,
        type: 'agent', agentType: 'CUSTOM', status: 'ACTIVE', visibility: 'private',
        description: 'Personal template copilot', objective: TEMPLATE_COPILOT_INSTRUCTIONS,
        schedule: { type: 'manual', isActive: false },
        metadata: { title: 'AI Copilot', model: TEMPLATE_COPILOT_MODEL, integrations: [], skills: [] },
      } })
      const copy = await tx.artifact.create({ data: {
        id, organizationId, userId, templateSourceId: source.id,
        title: `${source.title.slice(0, 180)} · my copy`,
        // An ROI copy is editable source, not a pointer to private facts/files.
        kind: source.kind === 'roi_dashboard' ? 'page' : source.kind,
        agentTaskId: agent.id, workspaceAccess: 'view',
        currentVersionId: versionId, versionCount: 1,
      }, select: { id: true } })
      await tx.artifactVersion.create({ data: {
        id: versionId, organizationId, artifactId: id, number: 1,
        content: version.content, request: 'Created personal template copy', createdByUserId: userId,
      } })
      return copy
    })
  } catch (error) {
    // Double-clicks and concurrent tabs return the same copy, with no orphan
    // agents/versions: the losing transaction is rolled back in full.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const copy = await prisma.artifact.findFirst({ where, select: { id: true } })
      if (copy) return copy
    }
    throw error
  }
}
