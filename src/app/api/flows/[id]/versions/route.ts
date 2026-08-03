import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { serializeFlow } from '@/lib/flows/serialize'
import { recordAudit } from '@/lib/audit'

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

// GET /api/flows/[id]/versions — list published snapshots (no graph payload),
// or ?version=N for a single snapshot with its graph (view overlay).
// POST /api/flows/[id]/versions — { version, action: 'restore' } copies that
// snapshot's graph into the flow's draft. id is the segment before "versions".
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')

  const versionParam = request.nextUrl.searchParams.get('version')
  if (versionParam != null) {
    const version = z.coerce.number().int().positive().parse(versionParam)
    const row = await prisma.flowVersion.findFirst({
      where: { flowId: id, organizationId: auth.organizationId, version },
    })
    if (!row) throw new ApiError('Version not found', 404, 'NOT_FOUND')
    return { success: true, version: row }
  }

  const versions = await prisma.flowVersion.findMany({
    where: { flowId: id, organizationId: auth.organizationId },
    orderBy: { version: 'desc' },
    take: 50,
    select: { id: true, version: true, note: true, publishedAt: true, publishedBy: true },
  })
  // Resolve publisher ids → display names so the History panel can show WHO
  // shipped each version (a collaborator's changes at a glance). One batched
  // lookup, org-scoped; unknown ids just show no name.
  const publisherIds = Array.from(new Set(versions.map((v) => v.publishedBy).filter((id): id is string => Boolean(id))))
  const publishers = publisherIds.length
    ? await prisma.user.findMany({ where: { id: { in: publisherIds }, organizationId: auth.organizationId }, select: { id: true, name: true, email: true } })
    : []
  const nameById = new Map(publishers.map((u) => [u.id, u.name || u.email || null]))

  // Per-user edit timeline: the recent `flow.edited` audit events (one per
  // manual save) with actor names, so History shows who changed the flow when —
  // the Jam-style change log, distinct from the coarser publish snapshots.
  const editEvents = await prisma.auditEvent.findMany({
    where: { organizationId: auth.organizationId, action: 'flow.edited', resourceType: 'flow', resourceId: id },
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { id: true, actorUserId: true, createdAt: true, detail: true },
  })
  const editorIds = Array.from(new Set(editEvents.map((e) => e.actorUserId).filter((v): v is string => Boolean(v))))
  const editors = editorIds.length
    ? await prisma.user.findMany({ where: { id: { in: editorIds }, organizationId: auth.organizationId }, select: { id: true, name: true, email: true } })
    : []
  const editorNameById = new Map(editors.map((u) => [u.id, u.name || u.email || null]))
  const recentEdits = editEvents.map((e) => ({
    id: e.id,
    at: e.createdAt,
    by: e.actorUserId ? editorNameById.get(e.actorUserId) ?? 'A teammate' : 'A teammate',
    detail: e.detail as { fields?: string[]; nodes?: number; edges?: number } | null,
  }))

  return {
    success: true,
    versions: versions.map((v) => ({ ...v, publishedByName: v.publishedBy ? nameById.get(v.publishedBy) ?? null : null })),
    recentEdits,
  }
}, { permission: 'flow.read' })

const restoreSchema = z.object({ version: z.number().int().positive(), action: z.literal('restore') })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')

  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true, visibility: true, userId: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(flow, auth.dbUser.id)

  const { version } = restoreSchema.parse(await request.json())
  const row = await prisma.flowVersion.findFirst({
    where: { flowId: id, organizationId: auth.organizationId, version },
  })
  if (!row) throw new ApiError('Version not found', 404, 'NOT_FOUND')

  const updated = await prisma.flow.update({ where: { id, organizationId: auth.organizationId }, data: { graph: jsonValue(row.graph) } })
  // A restore rewrites the draft canvas exactly as a manual save does, so it
  // belongs in the same timeline — without this the History panel showed the
  // draft silently changing with no entry explaining it. Awaited: fire-and-forget
  // work can be cut off when a serverless request ends.
  const restoredGraph = row.graph as { nodes?: unknown[]; edges?: unknown[] } | null
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'flow.edited',
    resourceType: 'flow',
    resourceId: id,
    detail: {
      fields: ['graph'],
      restoredFromVersion: version,
      ...(Array.isArray(restoredGraph?.nodes) ? { nodes: restoredGraph.nodes.length } : {}),
      ...(Array.isArray(restoredGraph?.edges) ? { edges: restoredGraph.edges.length } : {}),
    },
  }).catch(() => undefined)
  return { success: true, flow: serializeFlow(updated) }
}, { permission: 'flow.write' })
