import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { checkDailyRunAllowance, limitMessage } from '@/lib/usage/free-tier-limits'
import { askArtifact, ARTIFACT_QUESTION_MAX_CHARS } from '@/lib/artifacts/service'

export const runtime = 'nodejs'

// POST /api/artifacts/:id/chat — a message to the artifact's assistant. It
// decides whether the message is a question, a change (→ a new version) or,
// for an ROI dashboard, a request for another account. Either way it is a
// run; the answer lands when the run finishes.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Artifact id is required.', 400, 'ID_REQUIRED')
  const limited = await rateLimit(`artifact-chat:${auth.organizationId}`, { limit: 20, windowMs: 60_000 })
  if (limited) throw new ApiError('Too many messages at once. Try again in a minute.', 429, 'RATE_LIMITED')
  const allowance = await checkDailyRunAllowance('agent', { organizationId: auth.organizationId, userId: auth.dbUser.id, canReview: auth.can('catalogue.review'), email: auth.dbUser.email })
  if (allowance.over) throw new ApiError(limitMessage('agent', allowance.limit), 429, 'DAILY_LIMIT_REACHED')
  const parsed = z.object({ message: z.string().trim().min(1).max(ARTIFACT_QUESTION_MAX_CHARS), mode: z.enum(['auto', 'ask', 'change']).default('auto') }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Type a message first.', 400, 'INVALID_BODY')
  try {
    const artifact = await askArtifact({ organizationId: auth.organizationId, userId: auth.dbUser.id, id, message: parsed.data.message, mode: parsed.data.mode })
    return { success: true, artifact }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The message could not be sent.'
    throw new ApiError(message, message === 'Artifact not found.' ? 404 : 400, 'MESSAGE_REJECTED')
  }
}, { permission: 'agent.run' })
