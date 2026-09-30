import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { checkDailyRunAllowance, limitMessage } from '@/lib/usage/free-tier-limits'
import { rerunArtifactFlow, ARTIFACT_QUESTION_MAX_CHARS } from '@/lib/artifacts/service'

export const runtime = 'nodejs'

// POST /api/artifacts/:id/rerun-flow — re-run the flow that produced the
// artifact; a document in its output becomes the next version.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Artifact id is required.', 400, 'ID_REQUIRED')
  const limited = await rateLimit(`artifact-flow:${auth.organizationId}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many flow runs at once. Try again in a minute.', 429, 'RATE_LIMITED')
  const allowance = await checkDailyRunAllowance('flow', { organizationId: auth.organizationId, userId: auth.dbUser.id, canReview: auth.can('catalogue.review'), email: auth.dbUser.email })
  if (allowance.over) throw new ApiError(limitMessage('flow', allowance.limit), 429, 'DAILY_LIMIT_REACHED')
  const parsed = z.object({ message: z.string().trim().max(ARTIFACT_QUESTION_MAX_CHARS).default('') }).safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) throw new ApiError('Check the request and try again.', 400, 'INVALID_BODY')
  try {
    const artifact = await rerunArtifactFlow({ organizationId: auth.organizationId, userId: auth.dbUser.id, id, message: parsed.data.message })
    return { success: true, artifact }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The flow could not be started.'
    throw new ApiError(message, message === 'Artifact not found.' ? 404 : 400, 'FLOW_REJECTED')
  }
}, { permission: 'flow.run' })
