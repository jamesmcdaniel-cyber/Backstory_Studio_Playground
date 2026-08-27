import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { summarizeGraphChange } from '@/lib/flows/edit-summary'
import { canDecideReview } from '@/lib/flows/review-gate'
import { graphFingerprint } from '@/lib/flows/graph-fingerprint'
import { recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'

function jsonValue(value: unknown) {
  return JSON.parse(JSON.stringify(value ?? null))
}

async function loadFlow(id: string, organizationId: string, userId: string) {
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId, ...agentVisibilityScope(userId) },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  return flow
}

/** GET — the open review for this flow, and the workspace policy. */
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await loadFlow(id, auth.organizationId, auth.dbUser.id)

  const [org, review] = await Promise.all([
    prisma.organization.findFirst({ where: { id: auth.organizationId }, select: { flowReviewRequired: true } }),
    prisma.flowReview.findFirst({
      where: { flowId: id, organizationId: auth.organizationId },
      orderBy: { requestedAt: 'desc' },
      select: {
        id: true, status: true, note: true, summary: true,
        requestedBy: true, requestedAt: true, graph: true,
        decidedBy: true, decidedAt: true, decisionNote: true,
      },
    }),
  ])
  const decision = review
    ? canDecideReview(
        { requestedBy: review.requestedBy, status: review.status as 'open' | 'approved' | 'rejected' | 'withdrawn' },
        auth.dbUser.id,
      )
    : { allowed: false }
  const publicReview = review
    ? Object.fromEntries(Object.entries(review).filter(([key]) => key !== 'graph'))
    : null
  return {
    success: true,
    required: Boolean(org?.flowReviewRequired),
    review: publicReview,
    matchesDraft: Boolean(review && graphFingerprint(review.graph) === graphFingerprint(flow.graph)),
    canDecide: decision.allowed,
    canWithdraw: review?.status === 'open' && review.requestedBy === auth.dbUser.id,
  }
}, { permission: 'flow.read' })

/**
 * POST — ask for a review of the current draft.
 *
 * Snapshots the draft as submitted, so a reviewer approves what they actually
 * read rather than whatever the author edited afterwards.
 */
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { note } = z.object({ note: z.string().max(2000).optional() }).parse(await request.json().catch(() => ({})))

  const flow = await loadFlow(id, auth.organizationId, auth.dbUser.id)
  assertFlowEditable(flow, auth.dbUser.id)

  const open = await prisma.flowReview.findFirst({
    where: { flowId: id, organizationId: auth.organizationId, status: 'open' },
    select: { id: true },
  })
  if (open) throw new ApiError('This flow already has a review waiting.', 409, 'REVIEW_PENDING')

  const review = await prisma.flowReview.create({
    data: {
      flowId: id,
      organizationId: auth.organizationId,
      graph: jsonValue(flow.graph) as Prisma.InputJsonValue,
      summary: jsonValue(summarizeGraphChange(flow.publishedGraph ?? { nodes: [], edges: [] }, flow.graph ?? {})) as Prisma.InputJsonValue,
      note: note?.trim() || null,
      requestedBy: auth.dbUser.id,
    },
  })
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'flow.review_requested',
    resourceType: 'flow',
    resourceId: id,
    detail: { reviewId: review.id },
  }).catch(() => undefined)

  return { success: true, review: { id: review.id, status: review.status } }
}, { permission: 'flow.write' })

/**
 * PATCH — decide, or withdraw.
 *
 * Approving is gated on not being the author: a review you can approve
 * yourself is not a review, and that holds even for an owner, who can
 * otherwise do anything in the workspace. Withdrawing is the author's own.
 */
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const { decision, note } = z
    .object({ decision: z.enum(['approved', 'rejected', 'withdrawn']), note: z.string().max(2000).optional() })
    .parse(await request.json())

  await loadFlow(id, auth.organizationId, auth.dbUser.id)
  const review = await prisma.flowReview.findFirst({
    where: { flowId: id, organizationId: auth.organizationId, status: 'open' },
    select: { id: true, requestedBy: true, status: true },
  })
  if (!review) throw new ApiError('There is no review waiting on this flow.', 404, 'NO_REVIEW')

  if (decision === 'withdrawn') {
    if (review.requestedBy !== auth.dbUser.id) {
      throw new ApiError('Only the person who asked for the review can withdraw it.', 403, 'NOT_REQUESTER')
    }
  } else {
    const allowed = canDecideReview({ requestedBy: review.requestedBy, status: 'open' }, auth.dbUser.id)
    if (!allowed.allowed) throw new ApiError(allowed.message ?? 'You cannot decide this review.', 403, 'CANNOT_DECIDE')
  }

  // Conditioned on still being open, so two reviewers deciding at once cannot
  // both write a decision — the second updates nothing and is told why.
  const updated = await prisma.flowReview.updateMany({
    where: { id: review.id, organizationId: auth.organizationId, status: 'open' },
    data: {
      status: decision,
      decidedBy: decision === 'withdrawn' ? null : auth.dbUser.id,
      decidedAt: new Date(),
      decisionNote: note?.trim() || null,
    },
  })
  if (updated.count !== 1) throw new ApiError('This review was already decided.', 409, 'ALREADY_DECIDED')

  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: `flow.review_${decision}`,
    resourceType: 'flow',
    resourceId: id,
    detail: { reviewId: review.id },
  }).catch(() => undefined)

  return { success: true, review: { id: review.id, status: decision } }
}, { permission: 'flow.write' })
