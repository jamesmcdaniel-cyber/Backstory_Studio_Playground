import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { checkDailyRunAllowance, limitMessage } from '@/lib/usage/free-tier-limits'
import { createRoiAnalysis, serializeRoiAnalysis, ROI_CONTEXT_MAX_CHARS, ROI_MAX_DATASETS } from '@/lib/roi/service'
import { isRoiTimeframePreset } from '@/lib/roi/timeframe'
import { isRoiTemplate } from '@/lib/roi/sources'

export const runtime = 'nodejs'

// GET /api/roi/analyses — this workspace's analyses, newest first.
export const GET = withAuthenticatedApi(async (_request, auth) => {
  const rows = await prisma.roiAnalysis.findMany({
    where: { organizationId: auth.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  })
  return { success: true, analyses: rows.map((row) => serializeRoiAnalysis(row)) }
}, { permission: 'agent.read', internalOnly: true })

const bodySchema = z.object({
  account: z.string().trim().min(1).max(200),
  timeframe: z.string().refine(isRoiTimeframePreset, 'Pick a time frame.'),
  template: z.string().refine(isRoiTemplate, 'Pick an analysis.').optional(),
  context: z.string().max(ROI_CONTEXT_MAX_CHARS).default(''),
  datasetIds: z.array(z.string().min(1)).max(ROI_MAX_DATASETS).optional(),
})

// POST /api/roi/analyses — start an analysis. Returns at once; the run
// continues on the worker and the page follows it.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`roi-run:${auth.organizationId}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many analyses started at once. Try again in a minute.', 429, 'RATE_LIMITED')
  const allowance = await checkDailyRunAllowance('agent', { organizationId: auth.organizationId, userId: auth.dbUser.id, canReview: auth.can('catalogue.review'), email: auth.dbUser.email })
  if (allowance.over) throw new ApiError(limitMessage('agent', allowance.limit), 429, 'DAILY_LIMIT_REACHED')
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError(parsed.error.issues[0]?.message ?? 'Check the form and try again.', 400, 'INVALID_BODY')
  try {
    const row = await createRoiAnalysis({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      account: parsed.data.account,
      timeframe: { preset: parsed.data.timeframe },
      context: parsed.data.context,
      datasetIds: parsed.data.datasetIds,
      template: isRoiTemplate(parsed.data.template) ? parsed.data.template : undefined,
    })
    return { success: true, analysis: serializeRoiAnalysis(row) }
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : 'The analysis could not be started.', 400, 'ANALYSIS_REJECTED')
  }
}, { permission: 'agent.run', internalOnly: true })
