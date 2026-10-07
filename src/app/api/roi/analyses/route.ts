import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { checkDailyRunAllowance, limitMessage } from '@/lib/usage/free-tier-limits'
import { createRoiAnalysis, listRoiAnalyses, serializeRoiAnalysis, ROI_CONTEXT_MAX_CHARS, ROI_MAX_DATASETS, ROI_REASON_MAX_CHARS } from '@/lib/roi/service'
import { isRoiTimeframePreset } from '@/lib/roi/timeframe'
import { isRoiTemplate } from '@/lib/roi/sources'
import { configFromPreset, roiRunConfigSchema } from '@/lib/roi/config'
import { RoiDataUnavailableError } from '@/lib/roi/data-source'

export const runtime = 'nodejs'

// GET /api/roi/analyses — this workspace's analyses, newest first, for the
// ROI page's run history (with who ran each).
export const GET = withAuthenticatedApi(async (_request, auth) => {
  return { success: true, analyses: await listRoiAnalyses(auth.organizationId) }
}, { permission: 'agent.read', internalOnly: true })

const bodySchema = z.object({
  account: z.string().trim().min(1, 'Pick an account.').max(200),
  /** The ROI page sends a configuration and a reason; older callers a timeframe preset. */
  config: roiRunConfigSchema.optional(),
  reason: z.string().trim().max(ROI_REASON_MAX_CHARS).optional(),
  timeframe: z.string().refine(isRoiTimeframePreset, 'Pick a time frame.').optional(),
  template: z.string().refine(isRoiTemplate, 'Pick an analysis.').optional(),
  context: z.string().max(ROI_CONTEXT_MAX_CHARS).default(''),
  datasetIds: z.array(z.string().min(1)).max(ROI_MAX_DATASETS).optional(),
}).superRefine((body, ctx) => {
  if (body.config && !body.reason) ctx.addIssue({ code: 'custom', path: ['reason'], message: 'Say why you\'re running this analysis — it shapes what the report emphasises.' })
  if (!body.config && !body.timeframe) ctx.addIssue({ code: 'custom', path: ['config'], message: 'Choose the analysis time frame.' })
})

// POST /api/roi/analyses — start an analysis. Returns at once; the data
// fetch and the analyst's run continue in the background and the page
// follows them.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const limited = await rateLimit(`roi-run:${auth.organizationId}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many analyses started at once. Try again in a minute.', 429, 'RATE_LIMITED')
  const allowance = await checkDailyRunAllowance('agent', { organizationId: auth.organizationId, userId: auth.dbUser.id, canReview: auth.can('catalogue.review'), email: auth.dbUser.email })
  if (allowance.over) throw new ApiError(limitMessage('agent', allowance.limit), 429, 'DAILY_LIMIT_REACHED')
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError(parsed.error.issues[0]?.message ?? 'Check the form and try again.', 400, 'INVALID_BODY')
  const body = parsed.data
  try {
    const row = await createRoiAnalysis({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      account: body.account,
      config: body.config ? { ...body.config, custom: body.config.custom ?? null } : configFromPreset(body.timeframe),
      reason: body.reason ?? '',
      context: body.context,
      datasetIds: body.datasetIds,
      template: isRoiTemplate(body.template) ? body.template : undefined,
    })
    return { success: true, analysis: serializeRoiAnalysis(row, auth.dbUser.name?.trim() || auth.dbUser.email || null) }
  } catch (error) {
    if (error instanceof RoiDataUnavailableError) throw new ApiError(error.message, 400, 'NO_DATA')
    throw new ApiError(error instanceof Error ? error.message : 'The analysis could not be started.', 400, 'ANALYSIS_REJECTED')
  }
}, { permission: 'agent.run', internalOnly: true })
