import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { listArtifacts, isArtifactKind } from '@/lib/artifacts/service'

export const runtime = 'nodejs'

// GET /api/artifacts — the workspace's artifacts, newest first. ?kind=, ?agentId=, ?archived=true
export const GET = withAuthenticatedApi(async (request, auth) => {
  const params = request.nextUrl.searchParams
  const kind = params.get('kind')
  const artifacts = await listArtifacts(auth.organizationId, {
    kind: isArtifactKind(kind) ? kind : undefined,
    agentTaskId: params.get('agentId')?.slice(0, 100) || undefined,
    includeArchived: params.get('archived') === 'true',
  })
  return { success: true, artifacts }
}, { permission: 'agent.read' })
