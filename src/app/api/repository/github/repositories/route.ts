import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  GitHubConnectionUnavailableError,
  GitHubSyncUpstreamError,
  listGitHubRepositories,
} from '@/lib/knowledge/github-sync'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (_request, auth) => {
  try {
    return {
      success: true,
      ...(await listGitHubRepositories({
        organizationId: auth.organizationId,
        userId: auth.dbUser.id,
      })),
    }
  } catch (error) {
    if (error instanceof GitHubConnectionUnavailableError) {
      throw new ApiError(error.message, 409, 'GITHUB_NOT_CONNECTED')
    }
    if (error instanceof GitHubSyncUpstreamError) {
      throw new ApiError(error.message, 502, 'GITHUB_RESPONSE_INVALID')
    }
    throw error
  }
}, { permission: 'flow.read' })
