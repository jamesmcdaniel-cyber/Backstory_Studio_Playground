import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { replyToArtifactQuestion, ARTIFACT_QUESTION_MAX_CHARS } from '@/lib/artifacts/service'
import { requireEditable, viewerOf } from '@/lib/artifacts/route-access'
import { artifactPermissions } from '@/lib/artifacts/sharing'

export const runtime = 'nodejs'
export const maxDuration = 1800

// POST /api/artifacts/:id/reply — the answer to a question the artifact's
// assistant paused on. Asked and answered in the artifact's own conversation:
// whoever may change the artifact may answer, without going to the Runs panel
// or needing to own the agent behind it.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Artifact id is required.', 400, 'ID_REQUIRED')
  const editable = await requireEditable(auth, id)
  const limited = await rateLimit(`artifact-chat:${auth.organizationId}`, { limit: 20, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many messages at once. Try again in a minute.', 429, 'RATE_LIMITED')
  const parsed = z.object({ message: z.string().trim().min(1).max(ARTIFACT_QUESTION_MAX_CHARS) }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Type a message first.', 400, 'INVALID_BODY')
  try {
    const artifact = await replyToArtifactQuestion({ organizationId: auth.organizationId, id, message: parsed.data.message })
    return { success: true, artifact: { ...artifact, permissions: artifactPermissions(viewerOf(auth), editable) } }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The answer could not be sent.'
    throw new ApiError(message, message === 'Artifact not found.' ? 404 : message.startsWith('The assistant is not waiting') ? 409 : 400, 'MESSAGE_REJECTED')
  }
}, { permission: 'agent.read' })
