import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { assistantConfigSchema, loadAssistantSetup, saveAssistantConfig } from '@/lib/artifacts/assistant-config'

export const runtime = 'nodejs'

function artifactIdOf(request: Request): string {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Artifact id is required.', 400, 'ID_REQUIRED')
  return id
}

// GET /api/artifacts/:id/assistant — the assistant's settings and the
// workspace's connected tools it can use (the agent's own, always-on, and
// the ones a person can turn on).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const setup = await loadAssistantSetup(auth.organizationId, auth.dbUser.id, artifactIdOf(request))
  if (!setup) throw new ApiError('Artifact not found.', 404, 'NOT_FOUND')
  return { success: true, ...setup }
}, { permission: 'agent.read' })

// PATCH /api/artifacts/:id/assistant — save standing instructions and the
// extra connected tools the assistant may use.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const parsed = assistantConfigSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError(parsed.error.issues[0]?.message ?? 'Send instructions and toolConnectionIds.', 400, 'INVALID_BODY')
  const setup = await saveAssistantConfig(auth.organizationId, auth.dbUser.id, artifactIdOf(request), parsed.data)
  if (!setup) throw new ApiError('Artifact not found.', 404, 'NOT_FOUND')
  return { success: true, ...setup }
}, { permission: 'agent.write' })
