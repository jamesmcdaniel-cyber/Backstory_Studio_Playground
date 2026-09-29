import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { checkDailyRunAllowance, limitMessage } from '@/lib/usage/free-tier-limits'
import { askRoiQuestion, serializeRoiAnalysis, ROI_QUESTION_MAX_CHARS } from '@/lib/roi/service'

export const runtime = 'nodejs'

// POST /api/roi/analyses/:id/chat — ask a follow-up. The answer is a run of
// the same agent over the same datasets; it lands in the analysis's chat
// when the run finishes (the page polls GET /api/roi/analyses/:id).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Analysis id is required.', 400, 'ID_REQUIRED')
  const limited = await rateLimit(`roi-chat:${auth.organizationId}`, { limit: 20, windowMs: 60_000 })
  if (limited) throw new ApiError('Too many questions at once. Try again in a minute.', 429, 'RATE_LIMITED')
  const allowance = await checkDailyRunAllowance('agent', { organizationId: auth.organizationId, userId: auth.dbUser.id, canReview: auth.can('catalogue.review'), email: auth.dbUser.email })
  if (allowance.over) throw new ApiError(limitMessage('agent', allowance.limit), 429, 'DAILY_LIMIT_REACHED')
  const parsed = z.object({ question: z.string().trim().min(1).max(ROI_QUESTION_MAX_CHARS) }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Type a question first.', 400, 'INVALID_BODY')
  try {
    const row = await askRoiQuestion({ organizationId: auth.organizationId, userId: auth.dbUser.id, id, question: parsed.data.question })
    return { success: true, analysis: serializeRoiAnalysis(row) }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The question could not be sent.'
    throw new ApiError(message, message === 'Analysis not found.' ? 404 : 400, 'QUESTION_REJECTED')
  }
}, { permission: 'agent.run', internalOnly: true })
