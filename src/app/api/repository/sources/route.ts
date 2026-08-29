import { withAuthenticatedApi } from '@/lib/server/api-handler'
import { loadRepositoryPullSources } from '@/lib/knowledge/pull'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (_request, auth) => ({
  success: true,
  sources: await loadRepositoryPullSources(auth.organizationId, auth.dbUser.id),
}), { permission: 'flow.read' })
