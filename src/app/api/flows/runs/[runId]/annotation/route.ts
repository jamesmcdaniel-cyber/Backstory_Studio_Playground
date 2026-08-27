import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { recordAudit } from '@/lib/audit'

const metadataValue = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()])
const schema = z.object({
  annotation: z.string().trim().max(10_000).nullable().optional(),
  rating: z.number().int().min(1).max(5).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  customMetadata: z.record(z.string().trim().min(1).max(50), metadataValue).refine((value) => Object.keys(value).length <= 20, 'At most 20 metadata fields are allowed.').optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one annotation field is required.')

export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const runId = request.nextUrl.pathname.split('/').at(-2)
  if (!runId) throw new ApiError('Run id is required.', 400, 'MISSING_RUN_ID')
  const input = schema.parse(await request.json())
  const run = await prisma.flowRun.findFirst({
    where: {
      id: runId,
      organizationId: auth.organizationId,
      flow: { is: { organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) } },
    },
    select: { id: true, flow: { select: { id: true, visibility: true, userId: true } } },
  })
  if (!run) throw new ApiError('Run not found.', 404, 'NOT_FOUND')
  assertFlowEditable(run.flow, auth.dbUser.id)
  const tags = input.tags
    ? [...new Set(input.tags.map((tag) => tag.toLowerCase().replace(/\s+/g, '-')).filter(Boolean))]
    : undefined
  const updated = await prisma.flowRun.update({
    where: { id: run.id, organizationId: auth.organizationId },
    data: {
      ...(input.annotation !== undefined ? { annotation: input.annotation || null } : {}),
      ...(input.rating !== undefined ? { rating: input.rating } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(input.customMetadata !== undefined ? { customMetadata: input.customMetadata } : {}),
      annotatedByUserId: auth.dbUser.id,
      annotatedAt: new Date(),
    },
    select: { annotation: true, rating: true, tags: true, customMetadata: true, annotatedAt: true },
  })
  await recordAudit({
    organizationId: auth.organizationId,
    action: 'flow_run.annotated',
    actorUserId: auth.userId,
    resourceType: 'flow_run',
    resourceId: run.id,
    detail: { flowId: run.flow.id, rating: updated.rating, tags: updated.tags, metadataKeys: Object.keys(updated.customMetadata as object) },
  })
  return { success: true, annotation: updated }
}, { permission: 'flow.write' })
