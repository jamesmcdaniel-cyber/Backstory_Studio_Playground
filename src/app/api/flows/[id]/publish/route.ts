import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma, tenantTransaction } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { serializeFlow } from '@/lib/flows/serialize'
import { flowGraphSchema } from '@/lib/flows/graph'
import { validateFlowGraph, validationErrorMessage } from '@/lib/flows/validate'
import { activityMatchColumns, anchorTriggerSchedule, preserveWebhookSecretHash, triggerFromGraph } from '@/lib/flows/trigger'
import { loadRunValidationContext } from '@/lib/flows/run-validation'
import { recordAudit } from '@/lib/audit'
import { summarizeGraphChange } from '@/lib/flows/edit-summary'
import { canPublish } from '@/lib/flows/review-gate'
import { graphFingerprint } from '@/lib/flows/graph-fingerprint'
import { slackConfigured } from '@/lib/integrations/slack'
import { canArmEventTriggers } from '@/lib/usage/free-tier-limits'

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

  // Review gate. Checked BEFORE validation work and before anything is armed:
  // a publish that is not allowed should leave no trace and cost nothing.
  const reviewPolicy = await prisma.organization.findFirst({
    where: { id: auth.organizationId },
    select: { flowReviewRequired: true },
  })
  if (reviewPolicy?.flowReviewRequired) {
    const review = await prisma.flowReview.findFirst({
      where: { flowId: id, organizationId: auth.organizationId, status: { in: ['open', 'approved', 'rejected'] } },
      orderBy: { requestedAt: 'desc' },
      select: { status: true, requestedBy: true, decidedBy: true, graph: true },
    })
    const decision = canPublish({
      policy: { required: true },
      actorUserId: auth.dbUser.id,
      review: review
        ? {
            status: review.status as 'open' | 'approved' | 'rejected' | 'withdrawn',
            requestedBy: review.requestedBy,
            decidedBy: review.decidedBy,
            graphFingerprint: graphFingerprint(review.graph),
          }
        : null,
      // The draft as it stands right now — an approval is of a specific draft,
      // not of the flow forever.
      currentFingerprint: graphFingerprint(existing.graph),
    })
    if (!decision.allowed) throw new ApiError(decision.message, 409, decision.reason.toUpperCase())
  }
  // Which of the two event-trigger types (if either) this flow's trigger is,
  // so the slack/entitlement lookups below only run when they're actually
  // needed.
  const graphTriggerType = triggerFromGraph(graph, existing.trigger).type
  const isEventTrigger = graphTriggerType === 'activity' || graphTriggerType === 'slack'
  // The agents/connections/credentials half is the same question the run paths
  // ask (src/lib/flows/run-validation.ts) — shared so publishing and running
  // can never disagree about what "available" means. The trigger-shaped extras
  // below are publish-only.
  const [context, slackConnected, org] = await Promise.all([
    loadRunValidationContext(graph, { organizationId: auth.organizationId, userId: auth.dbUser.id }),
    graphTriggerType === 'slack' ? slackConfigured(auth.organizationId) : Promise.resolve(undefined),
    isEventTrigger
      ? prisma.organization.findUnique({ where: { id: auth.organizationId }, select: { plan: true, kind: true } })
      : Promise.resolve(undefined),
  ])
  const persistedTrigger = existing.trigger && typeof existing.trigger === 'object' && !Array.isArray(existing.trigger)
    ? existing.trigger as Record<string, unknown>
    : {}
  const validation = validateFlowGraph(graph, {
    agents: context.agentRefs,
    toolCatalog: context.toolCatalog,
    httpCredentials: context.httpCredentials,
    webhookSecretConfigured: typeof persistedTrigger.webhookSecretHash === 'string',
    ...(graphTriggerType === 'slack' ? { slackWorkspaceConnected: slackConnected === true } : {}),
    ...(isEventTrigger ? { eventTriggerEntitled: org ? canArmEventTriggers(org) : false } : {}),
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
  const nextTrigger = anchorTriggerSchedule(
    preserveWebhookSecretHash(triggerFromGraph(graph, existing.trigger), existing.trigger),
    existing.publishedGraph == null ? null : existing.trigger,
  )
  const trigger = jsonValue(nextTrigger)
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
        ...activityMatchColumns(nextTrigger),
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
