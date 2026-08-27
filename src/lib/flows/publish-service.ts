import { Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { ApiError } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { serializeFlow } from '@/lib/flows/serialize'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import {
  activityMatchColumns,
  anchorTriggerSchedule,
  preserveWebhookSecretHash,
  triggerFromGraph,
} from '@/lib/flows/trigger'
import { loadRunValidationContext } from '@/lib/flows/run-validation'
import { recordAudit } from '@/lib/audit'
import { summarizeGraphChange } from '@/lib/flows/edit-summary'
import { canPublish } from '@/lib/flows/review-gate'
import { graphFingerprint } from '@/lib/flows/graph-fingerprint'
import { slackConfigured } from '@/lib/integrations/slack'
import { canArmEventTriggers } from '@/lib/usage/free-tier-limits'

type PublishActor = {
  flowId: string
  organizationId: string
  userId: string
}

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

async function editableFlow({ flowId, organizationId, userId }: PublishActor) {
  const flow = await prisma.flow.findFirst({
    where: { id: flowId, organizationId, ...agentVisibilityScope(userId) },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(flow, userId)
  return flow
}

/** Revert the editable draft to the current live snapshot. */
export async function revertFlowDraft(actor: PublishActor) {
  const existing = await editableFlow(actor)
  if (existing.publishedGraph == null) throw new ApiError('Nothing published to revert to', 400, 'NO_PUBLISHED')
  const flow = await prisma.flow.update({
    where: { id: actor.flowId, organizationId: actor.organizationId },
    data: { graph: existing.publishedGraph },
  })
  return serializeFlow(flow)
}

/** Remove the live snapshot without destroying draft or version history. */
export async function unpublishFlowDraft(actor: PublishActor) {
  const existing = await editableFlow(actor)
  if (existing.publishedGraph == null) throw new ApiError('Flow is not published', 400, 'NOT_PUBLISHED')
  const flow = await prisma.flow.update({
    where: { id: actor.flowId, organizationId: actor.organizationId },
    data: { publishedGraph: Prisma.DbNull, status: 'DRAFT' },
  })
  await recordAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: 'flow.unpublished',
    resourceType: 'flow',
    resourceId: actor.flowId,
    detail: { version: existing.version },
  }).catch(() => undefined)
  return serializeFlow(flow)
}

/**
 * Publish one draft through the same review, trigger, dependency, entitlement,
 * and immutable-version gates regardless of whether the caller is the web UI,
 * public API, or MCP management plane.
 */
export async function publishFlowDraft(actor: PublishActor) {
  const existing = await editableFlow(actor)
  const graph = flowGraphSchema.parse(existing.graph)

  const reviewPolicy = await prisma.organization.findFirst({
    where: { id: actor.organizationId },
    select: { flowReviewRequired: true },
  })
  if (reviewPolicy?.flowReviewRequired) {
    const review = await prisma.flowReview.findFirst({
      where: {
        flowId: actor.flowId,
        organizationId: actor.organizationId,
        status: { in: ['open', 'approved', 'rejected'] },
      },
      orderBy: { requestedAt: 'desc' },
      select: { status: true, requestedBy: true, decidedBy: true, graph: true },
    })
    const decision = canPublish({
      policy: { required: true },
      actorUserId: actor.userId,
      review: review
        ? {
            status: review.status as 'open' | 'approved' | 'rejected' | 'withdrawn',
            requestedBy: review.requestedBy,
            decidedBy: review.decidedBy,
            graphFingerprint: graphFingerprint(review.graph),
          }
        : null,
      currentFingerprint: graphFingerprint(existing.graph),
    })
    if (!decision.allowed) throw new ApiError(decision.message, 409, decision.reason.toUpperCase())
  }

  const graphTriggerType = triggerFromGraph(graph, existing.trigger).type
  const isEventTrigger = graphTriggerType === 'activity' || graphTriggerType === 'slack'
  const [context, slackConnected, org] = await Promise.all([
    loadRunValidationContext(graph, { organizationId: actor.organizationId, userId: actor.userId }),
    graphTriggerType === 'slack' ? slackConfigured(actor.organizationId) : Promise.resolve(undefined),
    isEventTrigger
      ? prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { plan: true, kind: true } })
      : Promise.resolve(undefined),
  ])
  const persistedTrigger =
    existing.trigger && typeof existing.trigger === 'object' && !Array.isArray(existing.trigger)
      ? (existing.trigger as Record<string, unknown>)
      : {}
  const validation = validateFlowGraph(graph, {
    agents: context.agentRefs,
    toolCatalog: context.toolCatalog,
    httpCredentials: context.httpCredentials,
    credentialResolvers: context.credentialResolvers,
    webhookSecretConfigured: typeof persistedTrigger.webhookSecretHash === 'string',
    ...(graphTriggerType === 'slack' ? { slackWorkspaceConnected: slackConnected === true } : {}),
    ...(isEventTrigger ? { eventTriggerEntitled: org ? canArmEventTriggers(org) : false } : {}),
  })
  if (!validation.ok) throw new ApiError(validationErrorMessage(validation), 400, 'FLOW_VALIDATION_ERROR')

  const latestSnapshot = await prisma.flowVersion.findFirst({
    where: { flowId: actor.flowId, organizationId: actor.organizationId },
    orderBy: { version: 'desc' },
    select: { version: true, graph: true },
  })
  const nextVersion = (latestSnapshot?.version ?? 0) + 1
  const versionSummary = summarizeGraphChange(latestSnapshot?.graph ?? { nodes: [], edges: [] }, existing.graph ?? {})
  const nextTrigger = anchorTriggerSchedule(
    preserveWebhookSecretHash(triggerFromGraph(graph, existing.trigger), existing.trigger),
    existing.publishedGraph == null ? null : existing.trigger,
  )
  const trigger = jsonValue(nextTrigger)
  const flow = await tenantTransaction(actor.organizationId, async (tx) => {
    const updated = await tx.flow.update({
      where: { id: actor.flowId, organizationId: actor.organizationId },
      data: {
        trigger,
        publishedGraph: existing.graph ?? {},
        version: nextVersion,
        status: 'ACTIVE',
        ...activityMatchColumns(nextTrigger),
      },
    })
    await tx.flowVersion.create({
      data: {
        flowId: actor.flowId,
        organizationId: actor.organizationId,
        version: nextVersion,
        graph: jsonValue(existing.graph ?? {}),
        trigger,
        ...(versionSummary ? { summary: jsonValue(versionSummary) } : {}),
        publishedBy: actor.userId,
      },
    })
    return updated
  })
  await recordAudit({
    organizationId: actor.organizationId,
    actorUserId: actor.userId,
    action: 'flow.published',
    resourceType: 'flow',
    resourceId: actor.flowId,
    detail: { version: flow.version },
  }).catch(() => undefined)
  return serializeFlow(flow)
}
