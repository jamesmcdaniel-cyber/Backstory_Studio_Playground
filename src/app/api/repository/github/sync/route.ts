import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import {
  GitHubConnectionUnavailableError,
  GitHubSyncInputError,
  GitHubSyncUpstreamError,
  syncGitHubRepository,
} from '@/lib/knowledge/github-sync'
import { assertRepositoryAgentScope, RepositoryAssetNotFoundError } from '@/lib/knowledge/repository'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'
export const maxDuration = 180

const segment = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, 'Use a valid GitHub owner or repository name.')
const inputSchema = z.object({
  owner: segment,
  repo: segment,
  ref: z.string().trim().min(1).max(255).optional(),
  pathPrefix: z.string().trim().max(500).optional(),
  agentId: z.string().min(1).optional().nullable(),
  workspaceScope: z.boolean().default(false),
  maxFiles: z.number().int().min(1).max(50).default(50),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = inputSchema.parse(await request.json())
  const agentId = await assertRepositoryAgentScope({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    agentId: input.agentId,
  }).catch((error) => {
    if (error instanceof RepositoryAssetNotFoundError) throw new ApiError(error.message, 404, 'AGENT_NOT_FOUND')
    throw error
  })

  try {
    const result = await syncGitHubRepository({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      agentId,
      workspaceScope: input.workspaceScope,
      owner: input.owner,
      repo: input.repo,
      ref: input.ref,
      pathPrefix: input.pathPrefix,
      maxFiles: input.maxFiles,
    })
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'repository.github_synced',
      resourceType: 'repository_source',
      detail: {
        repository: result.repository.fullName,
        private: result.repository.private,
        ref: result.ref,
        pathPrefix: result.pathPrefix || null,
        scope: agentId ? 'agent' : 'workspace',
        agentId,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        disabled: result.disabled,
        failed: result.failed,
        skipped: result.skipped,
      },
    })
    return { success: true, result }
  } catch (error) {
    if (error instanceof GitHubConnectionUnavailableError) throw new ApiError(error.message, 409, 'GITHUB_NOT_CONNECTED')
    if (error instanceof GitHubSyncInputError) throw new ApiError(error.message, 400, 'GITHUB_SYNC_INVALID')
    if (error instanceof GitHubSyncUpstreamError) throw new ApiError(error.message, 502, 'GITHUB_RESPONSE_INVALID')
    throw error
  }
}, { permission: 'flow.write' })
