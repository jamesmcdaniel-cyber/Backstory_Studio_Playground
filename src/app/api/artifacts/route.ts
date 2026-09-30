import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { listArtifacts, isArtifactKind, createArtifact, ARTIFACT_UPLOAD_MAX_BYTES } from '@/lib/artifacts/service'
import { htmlTitleOf, looksLikeHtml } from '@/lib/html-detect'
import { unsupportedScripts } from '@/lib/artifacts/vendor-scripts'

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

const uploadSchema = z.object({
  content: z.string().min(20),
  filename: z.string().max(255).optional(),
  title: z.string().trim().max(200).optional(),
  agentId: z.string().min(1),
})

// POST /api/artifacts — upload an HTML page as an artifact the chosen agent
// works on: version 1 is the file as uploaded; the agent's edits are later
// versions (or new artifacts, when asked for a copy).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const parsed = uploadSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Send the page content and the agent that should work on it.', 400, 'INVALID_BODY')
  const { content, filename, agentId } = parsed.data
  if (Buffer.byteLength(content) > ARTIFACT_UPLOAD_MAX_BYTES) {
    throw new ApiError(`Pages can be at most ${Math.round(ARTIFACT_UPLOAD_MAX_BYTES / 1_000_000)} MB.`, 413, 'TOO_LARGE')
  }
  if (!looksLikeHtml(content.slice(0, 8_000))) throw new ApiError('That file does not look like an HTML page.', 415, 'NOT_HTML')
  const agent = await prisma.agentTask.findFirst({
    where: { id: agentId, organizationId: auth.organizationId, status: { not: 'DELETED' }, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!agent) throw new ApiError('Pick an agent you can use.', 404, 'AGENT_NOT_FOUND')
  const title = parsed.data.title || htmlTitleOf(content) || filename?.replace(/\.html?$/i, '') || 'Uploaded page'
  const { artifact } = await createArtifact({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    // A page with scripts runs them (sandboxed, no network); a static one is a report.
    kind: /<script\b/i.test(content) ? 'page' : 'report',
    title,
    content,
    agentTaskId: agent.id,
  })
  return { success: true, artifactId: artifact.id, unsupportedScripts: unsupportedScripts(content) }
}, { permission: 'agent.write', maxBodyBytes: ARTIFACT_UPLOAD_MAX_BYTES + 200_000 })
