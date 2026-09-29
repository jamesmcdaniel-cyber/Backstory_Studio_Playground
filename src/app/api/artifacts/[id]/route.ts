import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { archiveArtifact, loadArtifact } from '@/lib/artifacts/service'

export const runtime = 'nodejs'

function idOf(request: Request): string {
  const id = new URL(request.url).pathname.split('/').at(-1)
  if (!id) throw new ApiError('Artifact id is required.', 400, 'ID_REQUIRED')
  return id
}

// GET /api/artifacts/:id — the artifact, its versions and conversation (pending answers reconciled).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const artifact = await loadArtifact(auth.organizationId, idOf(request))
  if (!artifact) throw new ApiError('Artifact not found.', 404, 'NOT_FOUND')
  return { success: true, artifact }
}, { permission: 'agent.read' })

// PATCH /api/artifacts/:id — archive or restore.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const id = idOf(request)
  const parsed = z.object({ archived: z.boolean() }).safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Send { archived: boolean }.', 400, 'INVALID_BODY')
  const existing = await loadArtifact(auth.organizationId, id)
  if (!existing) throw new ApiError('Artifact not found.', 404, 'NOT_FOUND')
  await archiveArtifact(auth.organizationId, id, parsed.data.archived)
  return { success: true }
}, { permission: 'agent.write' })
