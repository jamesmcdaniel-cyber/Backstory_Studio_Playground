import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { executionStepLabel } from '@/lib/flows/execution-log'

const RUN_STATUSES = new Set(['running', 'succeeded', 'failed', 'waiting', 'cancelled', 'cancelling'])

// GET /api/flows/runs — paginated execution history across every flow the
// current user can see in their workspace. Cross-workspace shared flows are
// deliberately absent: their run data remains in the owning workspace.
export const GET = withAuthenticatedApi(async (request, auth) => {
  const searchParams = request.nextUrl.searchParams
  const requestedStatus = searchParams.get('status')?.trim() ?? ''
  if (requestedStatus && !RUN_STATUSES.has(requestedStatus)) throw new ApiError('Invalid run status filter.', 400, 'INVALID_RUN_STATUS')
  const status = RUN_STATUSES.has(requestedStatus) ? requestedStatus : ''
  const ratingText = searchParams.get('rating')?.trim() ?? ''
  const requestedRating = Number(ratingText)
  if (ratingText && (!Number.isInteger(requestedRating) || requestedRating < 1 || requestedRating > 5)) {
    throw new ApiError('Rating must be an integer from 1 through 5.', 400, 'INVALID_RUN_RATING')
  }
  const rating = ratingText ? requestedRating : undefined
  const tag = (searchParams.get('tag') ?? '').trim().toLowerCase().replace(/\s+/g, '-').slice(0, 50)
  const triggerType = (searchParams.get('trigger') ?? '').trim().slice(0, 40)
  const flowQuery = (searchParams.get('flow') ?? '').trim().slice(0, 120)
  const degradedText = (searchParams.get('degraded') ?? '').trim()
  if (degradedText && !['true', 'false'].includes(degradedText)) throw new ApiError('Degraded must be true or false.', 400, 'INVALID_DEGRADED_FILTER')
  const annotated = (searchParams.get('annotated') ?? '').trim()
  if (annotated && !['true', 'false'].includes(annotated)) throw new ApiError('Annotated must be true or false.', 400, 'INVALID_ANNOTATED_FILTER')
  const metadataKey = (searchParams.get('metadataKey') ?? '').trim().slice(0, 50)
  const metadataText = (searchParams.get('metadataValue') ?? '').slice(0, 500)
  const metadataType = (searchParams.get('metadataType') ?? 'string').trim()
  if (metadataKey && !['string', 'number', 'boolean', 'null'].includes(metadataType)) {
    throw new ApiError('Metadata type must be string, number, boolean, or null.', 400, 'INVALID_METADATA_TYPE')
  }
  let metadataValue: string | number | boolean | typeof Prisma.JsonNull = metadataText
  if (metadataKey && metadataType === 'number') {
    metadataValue = Number(metadataText)
    if (!Number.isFinite(metadataValue)) throw new ApiError('Metadata value must be a finite number.', 400, 'INVALID_METADATA_VALUE')
  } else if (metadataKey && metadataType === 'boolean') {
    if (!['true', 'false'].includes(metadataText.toLowerCase())) throw new ApiError('Metadata value must be true or false.', 400, 'INVALID_METADATA_VALUE')
    metadataValue = metadataText.toLowerCase() === 'true'
  } else if (metadataKey && metadataType === 'null') {
    metadataValue = Prisma.JsonNull
  }
  const fromText = searchParams.get('from')
  const toText = searchParams.get('to')
  const from = fromText ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(fromText) ? `${fromText}T00:00:00.000Z` : fromText) : null
  const to = toText ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(toText) ? `${toText}T23:59:59.999Z` : toText) : null
  if (from && Number.isNaN(from.getTime())) throw new ApiError('From date is invalid.', 400, 'INVALID_FROM_DATE')
  if (to && Number.isNaN(to.getTime())) throw new ApiError('To date is invalid.', 400, 'INVALID_TO_DATE')
  if (from && to && from > to) throw new ApiError('From date must not be after to date.', 400, 'INVALID_DATE_RANGE')
  const pageParam = Number(searchParams.get('page'))
  const takeParam = Number(searchParams.get('take'))
  const page = Number.isFinite(pageParam) && pageParam > 0 ? Math.floor(pageParam) : 1
  const take = Number.isFinite(takeParam) && takeParam > 0 ? Math.min(100, Math.floor(takeParam)) : 20

  const flowScope = {
    organizationId: auth.organizationId,
    ...agentVisibilityScope(auth.dbUser.id),
  }
  const where: Prisma.FlowRunWhereInput = {
    organizationId: auth.organizationId,
    ...(status ? { status } : {}),
    ...(rating ? { rating } : {}),
    ...(tag ? { tags: { has: tag } } : {}),
    ...(degradedText ? { degraded: degradedText === 'true' } : {}),
    ...(annotated ? { annotatedAt: annotated === 'true' ? { not: null } : null } : {}),
    ...(triggerType ? { trigger: { path: ['type'], equals: triggerType } } : {}),
    ...(metadataKey ? { customMetadata: { path: [metadataKey], equals: metadataValue } } : {}),
    ...(from || to
      ? { startedAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
    flow: {
      is: {
        ...flowScope,
        ...(flowQuery ? { OR: [
          { id: flowQuery },
          { name: { contains: flowQuery, mode: 'insensitive' } },
        ] } : {}),
      },
    },
  }

  const [total, runs] = await Promise.all([
    prisma.flowRun.count({ where }),
    prisma.flowRun.findMany({
      where,
      orderBy: { startedAt: 'desc' },
      skip: (page - 1) * take,
      take,
      select: {
        id: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        trigger: true,
        error: true,
        degraded: true,
        annotation: true,
        rating: true,
        tags: true,
        customMetadata: true,
        annotatedAt: true,
        graphSnapshot: true,
        flow: { select: { id: true, name: true, icon: true } },
        steps: {
          orderBy: { order: 'asc' },
          select: { nodeId: true, status: true, order: true, error: true, warnings: true },
        },
      },
    }),
  ])

  return {
    success: true,
    page,
    pageCount: Math.max(1, Math.ceil(total / take)),
    total,
    runs: runs.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      trigger: run.trigger,
      error: run.error,
      degraded: run.degraded,
      annotation: run.annotation,
      rating: run.rating,
      tags: run.tags,
      customMetadata: run.customMetadata,
      annotatedAt: run.annotatedAt,
      flow: run.flow,
      steps: run.steps.map((step) => ({
        nodeId: step.nodeId,
        label: executionStepLabel(run.graphSnapshot, step.nodeId),
        status: step.status,
        order: step.order,
        error: step.error,
        warnings: Array.isArray(step.warnings)
          ? step.warnings.filter((entry): entry is string => typeof entry === 'string')
          : null,
      })),
    })),
  }
}, { permission: 'flow.read' })
