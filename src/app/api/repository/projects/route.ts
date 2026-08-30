import { z } from 'zod'
import { recordAudit } from '@/lib/audit'
import { findSecretCandidates } from '@/lib/catalogue/sanitize'
import { ingestKnowledgeText, KNOWLEDGE_MAX_CHARS } from '@/lib/knowledge/ingest'
import { assertRepositoryAgentScope, RepositoryAssetNotFoundError } from '@/lib/knowledge/repository'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

export const runtime = 'nodejs'

const inputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  summary: z.string().trim().max(2_000).default(''),
  content: z.string().trim().min(1).max(200_000),
  agentId: z.string().min(1).optional().nullable(),
  workspaceScope: z.boolean().default(false),
})

function projectSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100) || 'project'
}

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
  if ((agentId === null) !== input.workspaceScope) {
    throw new ApiError('Choose exactly one project scope: a specific agent or the whole workspace.', 400, 'PROJECT_SCOPE_REQUIRED')
  }
  if (findSecretCandidates({ name: input.name, summary: input.summary, content: input.content }, 1).length) {
    throw new ApiError('Remove literal credentials before saving this project to the shared repository.', 400, 'PROJECT_SECRET_REFUSED')
  }

  const content = [
    `# ${input.name.replace(/[\r\n]+/g, ' ')}`,
    input.summary ? `\n${input.summary}` : '',
    `\n${input.content}`,
  ].join('').trim()
  if (content.length > KNOWLEDGE_MAX_CHARS) {
    throw new ApiError(`Project references can contain at most ${KNOWLEDGE_MAX_CHARS.toLocaleString()} characters including the title and summary.`, 413, 'PROJECT_TOO_LARGE')
  }
  const document = await ingestKnowledgeText({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    agentId,
    filename: `projects/${projectSlug(input.name)}.md`,
    description: input.summary || `Project reference: ${input.name}`,
    mimeType: 'text/markdown',
    content,
    assetType: 'project',
    sourceType: 'manual',
    sourceMetadata: {
      project: { name: input.name },
      scope: agentId ? 'agent' : 'workspace',
    },
  })
  await recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: 'repository.project_created',
    resourceType: 'repository_asset',
    resourceId: document.id,
    detail: { name: input.name, scope: agentId ? 'agent' : 'workspace', agentId },
  })
  return { success: true, document }
}, { permission: 'flow.write' })
