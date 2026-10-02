import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { checkDailyRunAllowance, limitMessage } from '@/lib/usage/free-tier-limits'
import { askArtifact, ARTIFACT_QUESTION_MAX_CHARS, clearArtifactChat, loadArtifact } from '@/lib/artifacts/service'
import { resolveChatModel } from '@/lib/llm/models'
import { requireEditable, viewerOf } from '@/lib/artifacts/route-access'
import { artifactPermissions } from '@/lib/artifacts/sharing'

export const runtime = 'nodejs'

// POST /api/artifacts/:id/chat — a message to the artifact's assistant. It
// decides whether the message is a question, a change (→ a new version) or,
// for an ROI dashboard, a request for another account. Either way it is a
// run; the answer lands when the run finishes.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Artifact id is required.', 400, 'ID_REQUIRED')
  // The assistant changes the artifact: edit access, per artifact, not role.
  const editable = await requireEditable(auth, id)
  const limited = await rateLimit(`artifact-chat:${auth.organizationId}`, { limit: 20, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many messages at once. Try again in a minute.', 429, 'RATE_LIMITED')
  const allowance = await checkDailyRunAllowance('agent', { organizationId: auth.organizationId, userId: auth.dbUser.id, canReview: auth.can('catalogue.review'), email: auth.dbUser.email })
  if (allowance.over) throw new ApiError(limitMessage('agent', allowance.limit), 429, 'DAILY_LIMIT_REACHED')
  const parsed = z.object({ message: z.string().trim().min(1).max(ARTIFACT_QUESTION_MAX_CHARS), mode: z.enum(['auto', 'ask', 'change']).default('auto'), model: z.string().max(80).optional() }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Type a message first.', 400, 'INVALID_BODY')
  try {
    const artifact = await askArtifact({ organizationId: auth.organizationId, userId: auth.dbUser.id, id, message: parsed.data.message, mode: parsed.data.mode, model: resolveChatModel(parsed.data.model, 'artifact') })
    return { success: true, artifact: { ...artifact, permissions: artifactPermissions(viewerOf(auth), editable) } }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The message could not be sent.'
    throw new ApiError(message, message === 'Artifact not found.' ? 404 : 400, 'MESSAGE_REJECTED')
  }
}, { permission: 'agent.read' })

// DELETE /api/artifacts/:id/chat — start a new chat: the conversation is
// cleared, the artifact and its versions are untouched.
export const DELETE = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Artifact id is required.', 400, 'ID_REQUIRED')
  const editable = await requireEditable(auth, id)
  try {
    await clearArtifactChat({ organizationId: auth.organizationId, id })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'A new chat could not be started.'
    throw new ApiError(message, message === 'Artifact not found.' ? 404 : 409, 'CHAT_BUSY')
  }
  const artifact = await loadArtifact(auth.organizationId, id)
  return { success: true, artifact: artifact ? { ...artifact, permissions: artifactPermissions(viewerOf(auth), editable) } : null }
}, { permission: 'agent.read' })
