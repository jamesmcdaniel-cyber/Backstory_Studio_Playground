import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { versionContent } from '@/lib/artifacts/service'
import { artifactPageResponse } from '@/lib/artifacts/serve'

export const runtime = 'nodejs'

// GET /api/artifacts/:id/versions/:versionId/content — the document itself
// ("current" for the current version), served as a page for the viewer's
// iframe with a policy matched to what it holds (src/lib/artifacts/serve.ts).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const parts = new URL(request.url).pathname.split('/')
  const versionId = parts.at(-2)
  const id = parts.at(-4)
  if (!id || !versionId) throw new ApiError('Artifact and version ids are required.', 400, 'ID_REQUIRED')
  const found = await versionContent(auth.organizationId, id, versionId === 'current' ? 'current' : versionId)
  if (!found) throw new ApiError('Version not found.', 404, 'NOT_FOUND')
  return artifactPageResponse(found, new URL(request.url).origin)
}, { permission: 'agent.read' })
