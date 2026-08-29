import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import { resolveFlowToolExecutor } from '@/features/agents/tool-planes'
import { ingestKnowledgeText } from '@/lib/knowledge/ingest'
import { loadRepositoryPullSources, pullResultText, redactPullArguments, safePullError } from '@/lib/knowledge/pull'
import {
  assertRepositoryAgentScope,
  createFailedPullArtifact,
  RepositoryAssetNotFoundError,
} from '@/lib/knowledge/repository'
import { recordAudit } from '@/lib/audit'

export const runtime = 'nodejs'
export const maxDuration = 180

const inputSchema = z.object({
  connectionId: z.string().min(1).max(300),
  toolName: z.string().min(1).max(200),
  args: z.record(z.string(), z.unknown()).default({}),
  filename: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(2_000).optional(),
  agentId: z.string().min(1).optional().nullable(),
})

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)

export const POST = withAuthenticatedApi(async (request, auth) => {
  const input = inputSchema.parse(await request.json())
  const source = (await loadRepositoryPullSources(auth.organizationId, auth.dbUser.id)).find(
    (candidate) => candidate.connectionId === input.connectionId && candidate.toolName === input.toolName,
  )
  if (!source) throw new ApiError('That read action is not available for repository pulls.', 400, 'PULL_SOURCE_UNAVAILABLE')
  const parsed = parseFlowToolConnectionId(input.connectionId)
  const agentId = await assertRepositoryAgentScope({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    agentId: input.agentId,
  }).catch((error) => {
    if (error instanceof RepositoryAssetNotFoundError) throw new ApiError(error.message, 404, 'AGENT_NOT_FOUND')
    throw error
  })
  const pulledAt = new Date()
  const filename = input.filename ?? `${slug(source.connectionName)}-${slug(input.toolName)}-${pulledAt.toISOString().slice(0, 10)}.json`
  const provenance = {
    args: redactPullArguments(input.args),
    connectionName: source.connectionName,
    pulledAt: pulledAt.toISOString(),
  }

  try {
    const executor = await resolveFlowToolExecutor({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      plane: parsed.plane,
      ref: parsed.ref,
      toolName: input.toolName,
    })
    if (executor.isWrite) throw new ApiError('Repository pulls can only run read actions.', 400, 'PULL_WRITE_REFUSED')
    const result = await executor.execute(input.toolName, input.args)
    const materialized = pullResultText(result)
    const document = await ingestKnowledgeText({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      agentId,
      filename,
      description: input.description ?? `Pulled from ${source.connectionName} with ${input.toolName}.`,
      mimeType: materialized.mimeType,
      content: materialized.content,
      assetType: 'pull_artifact',
      sourceType: 'integration',
      sourceProvider: executor.provider,
      sourceConnectionId: input.connectionId,
      sourceTool: input.toolName,
      sourceMetadata: { ...provenance, truncated: materialized.truncated },
      lastSyncedAt: pulledAt,
    })
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'repository.pulled',
      resourceType: 'repository_asset',
      resourceId: document.id,
      detail: { provider: executor.provider, tool: input.toolName, agentId, truncated: materialized.truncated },
    })
    return { success: true, document }
  } catch (error) {
    if (error instanceof ApiError) throw error
    const message = safePullError(error)
    const failed = await createFailedPullArtifact({
      organizationId: auth.organizationId,
      userId: auth.dbUser.id,
      agentId,
      filename,
      provider: source.connectionName,
      connectionId: input.connectionId,
      toolName: input.toolName,
      sourceMetadata: provenance,
      error: message,
    }).catch(() => null)
    await recordAudit({
      organizationId: auth.organizationId,
      actorUserId: auth.dbUser.id,
      action: 'repository.pull_failed',
      resourceType: 'repository_asset',
      resourceId: failed?.id,
      detail: { provider: source.connectionName, tool: input.toolName, error: message },
    }).catch(() => {})
    throw new ApiError(`The integration pull failed: ${message}`, 502, 'PULL_FAILED')
  }
}, { permission: 'flow.write' })
