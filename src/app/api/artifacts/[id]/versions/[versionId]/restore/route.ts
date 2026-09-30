import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { loadArtifact, restoreVersion } from '@/lib/artifacts/service'

export const runtime = 'nodejs'

// POST /api/artifacts/:id/versions/:versionId/restore — make an earlier
// version current again, as a new version at the top (history is kept).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const parts = new URL(request.url).pathname.split('/')
  const versionId = parts.at(-2)
  const id = parts.at(-4)
  if (!id || !versionId) throw new ApiError('Artifact and version ids are required.', 400, 'ID_REQUIRED')
  try {
    await restoreVersion({ organizationId: auth.organizationId, userId: auth.dbUser.id, artifactId: id, versionId })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The version could not be restored.'
    throw new ApiError(message, /not found/i.test(message) ? 404 : 400, 'RESTORE_REJECTED')
  }
  return { success: true, artifact: await loadArtifact(auth.organizationId, id) }
}, { permission: 'agent.write' })
