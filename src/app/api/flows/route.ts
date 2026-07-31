import { z } from 'zod'
import { prisma, systemPrisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { flowGraphSchema, emptyGraph } from '@/lib/flows/graph'
import { serializeFlow } from '@/lib/flows/serialize'
import { normalizeFlowTrigger, preserveWebhookSecretHash, triggerFromGraph } from '@/lib/flows/trigger'
import { assertFlowEditable, resolveFlowRole } from '@/lib/flows/access'
import { recordAudit } from '@/lib/audit'

// Strip undefined + narrow to plain JSON so Prisma's InputJsonValue accepts the
// zod-inferred shapes (passthrough trigger / discriminated-union graph).
function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

const triggerSchema = z.object({ type: z.enum(['manual', 'schedule', 'webhook', 'signal']).default('manual') }).passthrough()
const flowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']).default('DRAFT'),
  visibility: z.enum(['shared', 'private', 'view']).default('shared'),
  trigger: triggerSchema.optional(),
  graph: flowGraphSchema.optional(),
  folder: z.string().max(60).optional(),
})

export const GET = withAuthenticatedApi(async (_request, auth) => {
  // Org flows (v1 visibility rules) PLUS flows shared with this user across
  // workspaces (accepted collaborator rows).
  //
  // systemPrisma: deliberately cross-tenant. The second OR branch matches flows
  // in OTHER orgs — that is the whole point of an accepted collaborator row, and
  // it is the same grant GET /api/flows/[id] resolves. The access boundary is
  // the collaborator row itself (only this user's), and resolveFlowRole below
  // decides what each result is worth to them. The tenant guard rejects this
  // shape by design now, because an OR branch without org scope is exactly what
  // an accidental leak looks like — so it has to be spelled out here instead.
  const flows = await systemPrisma.flow.findMany({
    where: {
      OR: [
        { organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
        { collaborators: { some: { userId: auth.dbUser.id } } },
      ],
    },
    include: { collaborators: { where: { userId: auth.dbUser.id } } },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  })
  const viewer = { userId: auth.dbUser.id, organizationId: auth.organizationId }
  return {
    success: true,
    flows: flows.map((flow) => {
      const role = resolveFlowRole({ ...flow, collaboratorRole: flow.collaborators[0]?.role ?? null }, viewer)
      const external = flow.organizationId !== auth.organizationId
      return serializeFlow(flow, auth.dbUser.id, role ? { role, external, includeShare: !external && role === 'edit' } : undefined)
    }),
  }
}, { permission: 'flow.read' })

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = flowSchema.parse(await request.json())
  const graph = data.graph ?? emptyGraph()
  const trigger = data.trigger ? normalizeFlowTrigger(data.trigger) : triggerFromGraph(graph)
  const flow = await prisma.flow.create({
    data: {
      name: data.name,
      description: data.description,
      status: data.status,
      visibility: data.visibility,
      folder: data.folder ?? '',
      trigger: jsonValue(trigger),
      graph: jsonValue(graph),
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
    },
  })
  return { success: true, flow: serializeFlow(flow) }
}, { permission: 'flow.write' })

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z.object({
    id: z.string().min(1),
    baseUpdatedAt: z.string().optional(),
    // Jam autosaves coalesce audit rows client-side (one per window) instead
    // of one per debounce tick.
    suppressAudit: z.boolean().optional(),
  }).merge(flowSchema.partial()).parse(await request.json())
  // systemPrisma: deliberately cross-tenant — an external collaborator's save
  // must find the flow outside their org; resolveFlowRole below is the access
  // boundary, and the update itself re-scopes to the OWNING org.
  const existing = await systemPrisma.flow.findUnique({
    where: { id: body.id },
    include: { collaborators: { where: { userId: auth.dbUser.id } } },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  const role = resolveFlowRole(
    { ...existing, collaboratorRole: existing.collaborators[0]?.role ?? null },
    { userId: auth.dbUser.id, organizationId: auth.organizationId },
  )
  if (!role) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  if (role !== 'edit') throw new ApiError('This flow is view-only for you — ask its owner for edit access.', 403, 'FLOW_VIEW_ONLY')
  // Guests (cross-workspace collaborators) may write the CANVAS only — name,
  // sharing, and settings stay with the owning workspace.
  if (existing.organizationId !== auth.organizationId) {
    const allowed = new Set(['id', 'graph', 'baseUpdatedAt', 'suppressAudit'])
    const blocked = Object.keys(body).filter((key) => (body as Record<string, unknown>)[key] !== undefined && !allowed.has(key))
    if (blocked.length) {
      throw new ApiError('Guests can edit the canvas only — name, sharing, and settings stay with the owning workspace.', 403, 'GUEST_GRAPH_ONLY')
    }
  }
  // Optimistic concurrency: when a graph write carries the baseUpdatedAt the
  // client last loaded, reject if the flow has moved on since (a co-editor
  // saved) so a stale full-graph PUT can't silently clobber their work. The
  // client reloads/merges on 409. Omitted baseUpdatedAt keeps the old
  // last-write-wins behavior for callers that don't opt in.
  if (body.graph !== undefined && body.baseUpdatedAt && existing.updatedAt.toISOString() !== body.baseUpdatedAt) {
    throw new ApiError('This flow changed since you opened it — reload to get the latest before saving.', 409, 'FLOW_STALE_WRITE')
  }
  const nextTrigger =
    body.trigger !== undefined
      ? normalizeFlowTrigger(body.trigger)
      : body.graph !== undefined
        ? triggerFromGraph(body.graph, existing.trigger)
        : undefined
  const data = {
    ...(body.name !== undefined && { name: body.name }),
    ...(body.description !== undefined && { description: body.description }),
    // Lifecycle is owned by publish/unpublish, NOT by this endpoint. Accepting
    // a status here let any caller with a stale client-side value silently
    // demote a published (ACTIVE) flow back to DRAFT — the flow kept running
    // from its publishedGraph while its card read "Draft". A caller that wants
    // to arm or disarm a flow uses /publish.
    ...(body.status !== undefined && body.status !== 'ACTIVE' && existing.publishedGraph == null
      ? { status: body.status }
      : {}),
    ...(body.visibility !== undefined && { visibility: body.visibility }),
    ...(body.folder !== undefined && { folder: body.folder }),
    // Preserve the webhook secret hash across trigger edits — the client
    // never sees it, so a plain PUT would silently wipe it.
    ...(nextTrigger !== undefined && { trigger: jsonValue(preserveWebhookSecretHash(nextTrigger, existing.trigger)) }),
    ...(body.graph !== undefined && { graph: jsonValue(body.graph) }),
  }
  // Scoped to the OWNING org (which for a guest differs from the caller's).
  let flow
  if (body.baseUpdatedAt) {
    // Atomic optimistic-concurrency guard. The stale-CLIENT check above compares
    // our fresh read to what the client loaded; this closes the TOCTOU between
    // that read and this write by making the update CONDITIONAL on updatedAt not
    // having moved since — so two persisters that both passed the check above
    // can't both commit a full-graph replace (the loser matches 0 rows).
    const result = await prisma.flow.updateMany({
      where: { id: body.id, organizationId: existing.organizationId, updatedAt: existing.updatedAt },
      data,
    })
    if (result.count === 0) {
      throw new ApiError('This flow changed since you opened it — reload to get the latest before saving.', 409, 'FLOW_STALE_WRITE')
    }
    flow = await prisma.flow.findFirstOrThrow({ where: { id: body.id, organizationId: existing.organizationId } })
  } else {
    // No baseUpdatedAt: documented last-write-wins for callers that don't opt in.
    flow = await prisma.flow.update({ where: { id: body.id, organizationId: existing.organizationId }, data })
  }
  // Per-user edit log: record WHO saved a graph change, so the History panel can
  // show a Jam-style timeline of who edited when. Jam autosaves coalesce via
  // suppressAudit (one row per window), so this stays low-volume; best-effort,
  // never blocks the save.
  if (body.graph !== undefined && !body.suppressAudit) {
    void recordAudit({
      // Edits audit into the OWNING org's timeline — including guest edits.
      organizationId: existing.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'flow.edited',
      resourceType: 'flow',
      resourceId: body.id,
      detail: { nodes: body.graph.nodes.length, edges: body.graph.edges.length },
    }).catch(() => undefined)
  }
  return { success: true, flow: serializeFlow(flow) }
}, { permission: 'flow.write' })

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const { id } = z.object({ id: z.string().min(1) }).parse(await request.json())
  const existing = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(existing, auth.dbUser.id)
  await prisma.flow.deleteMany({ where: { id, organizationId: auth.organizationId } })
  return { success: true }
}, { permission: 'flow.write' })
