import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { serializeFlow } from '@/lib/flows/serialize'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import { anchorTriggerSchedule, preserveWebhookSecretHash, triggerFromGraph } from '@/lib/flows/trigger'
import { loadFlowToolCatalog } from '@/lib/flows/tool-catalog'
import { recordAudit } from '@/lib/audit'
import { summarizeGraphChange } from '@/lib/flows/edit-summary'

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

// POST /api/flows/[id]/publish — publish the draft (graph → publishedGraph,
// status ACTIVE, version = publish count), revert the draft to the published
// version ({ revert: true }), or unpublish ({ unpublish: true } — clears
// publishedGraph and deactivates; version history is kept).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { revert, unpublish } = z
    .object({ revert: z.boolean().default(false), unpublish: z.boolean().default(false) })
    .parse(await request.json().catch(() => ({})))

  const existing = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
  })
  if (!existing) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(existing, auth.dbUser.id)

  if (revert) {
    if (existing.publishedGraph == null) throw new ApiError('Nothing published to revert to', 400, 'NO_PUBLISHED')
    const flow = await prisma.flow.update({ where: { id, organizationId: auth.organizationId }, data: { graph: existing.publishedGraph } })
    return { success: true, flow: serializeFlow(flow) }
  }

  if (unpublish) {
    if (existing.publishedGraph == null) throw new ApiError('Flow is not published', 400, 'NOT_PUBLISHED')
    const flow = await prisma.flow.update({
      where: { id, organizationId: auth.organizationId },
      data: { publishedGraph: Prisma.DbNull, status: 'DRAFT' },
    })
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'flow.unpublished',
      resourceType: 'flow',
      resourceId: id,
      detail: { version: existing.version },
    }).catch(() => undefined)
    return { success: true, flow: serializeFlow(flow) }
  }

  const graph = flowGraphSchema.parse(existing.graph)
  const usedConnectionIds = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'tool' || node.type === 'http'
      ? [node.data.connectionId]
      : node.type === 'agent'
        ? node.data.toolConnectionIds ?? []
        : [],
  ).filter((id): id is string => Boolean(id))))
  const usedHttpCredentialIds = Array.from(new Set(graph.nodes.flatMap((node) =>
    node.type === 'http' ? [node.data.credentialId] : [],
  ).filter((id): id is string => Boolean(id))))
  const [agents, connections, httpCredentials] = await Promise.all([
    prisma.agentTask.findMany({
      where: { organizationId: auth.organizationId, status: 'ACTIVE', ...agentVisibilityScope(auth.dbUser.id) },
      select: { id: true, description: true },
      take: 500,
    }),
    usedConnectionIds.length
      ? loadFlowToolCatalog(auth.organizationId, { userId: auth.dbUser.id, connectionIds: usedConnectionIds, takeConnections: usedConnectionIds.length, takeTools: 100 })
      : Promise.resolve([]),
    usedHttpCredentialIds.length
      ? prisma.httpCredential.findMany({
          where: { organizationId: auth.organizationId, id: { in: usedHttpCredentialIds }, status: { in: ['verified', 'error'] } },
          select: { id: true },
        })
      : Promise.resolve([]),
  ])
  const persistedTrigger = existing.trigger && typeof existing.trigger === 'object' && !Array.isArray(existing.trigger)
    ? existing.trigger as Record<string, unknown>
    : {}
  const validation = validateFlowGraph(graph, {
    agents: agents.map((agent) => ({ id: agent.id, title: agent.description })),
    toolCatalog: connections,
    httpCredentials,
    webhookSecretConfigured: typeof persistedTrigger.webhookSecretHash === 'string',
  })
  if (!validation.ok) {
    throw new ApiError(validationErrorMessage(validation), 400, 'FLOW_VALIDATION_ERROR')
  }

  // Version = publish count: v1 on the first publish, +1 per publish after.
  // Derived from the snapshot history (not flow.version, which seeds at 1) so
  // the number keeps advancing across unpublish/republish cycles.
  const latestSnapshot = await prisma.flowVersion.findFirst({
    where: { flowId: id, organizationId: auth.organizationId },
    orderBy: { version: 'desc' },
    select: { version: true, graph: true },
  })
  const nextVersion = (latestSnapshot?.version ?? 0) + 1
  // What this version changes vs the previous published one (v1 diffs against
  // an empty graph — "added N steps" is the honest first-publish story).
  const versionSummary = summarizeGraphChange(latestSnapshot?.graph ?? { nodes: [], edges: [] }, existing.graph ?? {})
  // Publishing is what ARMS a schedule (only ACTIVE published flows are
  // scanned), so a first publish anchors it fresh at now — otherwise a
  // schedule configured days earlier would instantly "catch up" the moment it
  // went live. A republish keeps the anchor unless the schedule changed.
  const trigger = jsonValue(
    anchorTriggerSchedule(
      preserveWebhookSecretHash(triggerFromGraph(graph, existing.trigger), existing.trigger),
      existing.publishedGraph == null ? null : existing.trigger,
    ),
  )
  const flow = await tenantTransaction(auth.organizationId, async (tx) => {
    const updated = await tx.flow.update({
      where: { id, organizationId: auth.organizationId },
      data: {
        trigger,
        publishedGraph: existing.graph ?? {},
        version: nextVersion,
        // Publishing arms the flow: triggers/schedules/signals all require
        // ACTIVE. Lifecycle is owned by publish/unpublish, not a separate toggle.
        status: 'ACTIVE',
      },
    })
    await tx.flowVersion.create({
      data: {
        flowId: id,
        organizationId: auth.organizationId,
        version: nextVersion,
        graph: jsonValue(existing.graph ?? {}),
        trigger,
        ...(versionSummary ? { summary: jsonValue(versionSummary) } : {}),
        publishedBy: auth.dbUser.id,
      },
    })
    return updated
  })
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'flow.published',
    resourceType: 'flow',
    resourceId: id,
    detail: { version: flow.version },
  }).catch(() => undefined)
  return { success: true, flow: serializeFlow(flow) }
}, { permission: 'flow.write' })
