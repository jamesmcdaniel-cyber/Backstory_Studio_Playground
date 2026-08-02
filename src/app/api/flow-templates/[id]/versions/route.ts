import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { serializeFlowTemplate } from '@/lib/flows/templates/catalogue'
import { restoreFlowTemplateVersion, type FlowTemplateSnapshot } from '@/lib/flows/templates/versions'

// GET /api/flow-templates/[id]/versions — history for a stored template the
// viewer's org owns (built-ins have no rows and 404 here, deliberately):
// list without payloads, or ?version=N for one snapshot.
// POST — { version, action: 'restore' } overwrites the template with that
// snapshot (itself versioned, so a restore is undoable).
// id is the path segment before "versions".
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Template id is required')
  const template = await prisma.flowTemplate.findFirst({
    where: { id, organizationId: auth.organizationId },
    select: { id: true, version: true },
  })
  if (!template) throw new ApiError('Flow template not found', 404, 'NOT_FOUND')

  const versionParam = request.nextUrl.searchParams.get('version')
  if (versionParam != null) {
    const version = z.coerce.number().int().positive().parse(versionParam)
    const row = await prisma.flowTemplateVersion.findFirst({
      where: { templateId: id, organizationId: auth.organizationId, version },
    })
    if (!row) throw new ApiError('Version not found', 404, 'NOT_FOUND')
    return { success: true, version: { version: row.version, savedBy: row.savedBy, createdAt: row.createdAt, snapshot: row.snapshot as FlowTemplateSnapshot } }
  }

  const versions = await prisma.flowTemplateVersion.findMany({
    where: { templateId: id, organizationId: auth.organizationId },
    orderBy: { version: 'desc' },
    take: 50,
    select: { id: true, version: true, savedBy: true, createdAt: true },
  })
  // Saver ids → display names, one batched org-scoped lookup (History shows who).
  const saverIds = Array.from(new Set(versions.map((v) => v.savedBy).filter((v): v is string => Boolean(v))))
  const savers = saverIds.length
    ? await prisma.user.findMany({ where: { id: { in: saverIds }, organizationId: auth.organizationId }, select: { id: true, name: true, email: true } })
    : []
  const nameById = new Map(savers.map((u) => [u.id, u.name || u.email || null]))
  return {
    success: true,
    currentVersion: template.version,
    versions: versions.map((v) => ({ ...v, savedByName: v.savedBy ? (nameById.get(v.savedBy) ?? null) : null })),
  }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Template id is required')
  const { version } = z.object({ version: z.number().int().positive(), action: z.literal('restore') }).parse(await request.json())
  const existing = await prisma.flowTemplate.findFirst({ where: { id, organizationId: auth.organizationId } })
  if (!existing) throw new ApiError('Flow template not found', 404, 'NOT_FOUND')
  const restored = await restoreFlowTemplateVersion(existing, version, auth.dbUser.id)
  if (!restored) throw new ApiError('Version not found', 404, 'NOT_FOUND')
  return { success: true, template: serializeFlowTemplate(restored, auth.organizationId) }
}, { permission: 'template.author' })
