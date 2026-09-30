import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { listArtifacts, isArtifactKind, createArtifact, ARTIFACT_UPLOAD_MAX_BYTES } from '@/lib/artifacts/service'
import { htmlTitleOf, looksLikeHtml } from '@/lib/html-detect'
import { artifactDocumentForUpload } from '@/lib/artifacts/runtime'
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
  content: z.string().min(1),
  filename: z.string().max(255).optional(),
  title: z.string().trim().max(200).optional(),
  agentId: z.string().min(1),
})

// POST /api/artifacts — upload an HTML page (or a React component, or a
// TypeScript, JavaScript, Python or CSS file) as an artifact the chosen agent
// works on: version 1 is the file as uploaded; the agent's edits are later
// versions (or new artifacts, when asked for a copy).
export const POST = withAuthenticatedApi(async (request, auth) => {
  const parsed = uploadSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError('Send the page content and the agent that should work on it.', 400, 'INVALID_BODY')
  const { content, filename, agentId } = parsed.data
  if (Buffer.byteLength(content) > ARTIFACT_UPLOAD_MAX_BYTES) {
    throw new ApiError(`Pages can be at most ${Math.round(ARTIFACT_UPLOAD_MAX_BYTES / 1_000_000)} MB.`, 413, 'TOO_LARGE')
  }
  const document = artifactDocumentForUpload(content, filename ?? '')
    ?? (looksLikeHtml(content.slice(0, 8_000)) ? { content, kind: /<script\b/i.test(content) ? 'page' as const : 'report' as const } : null)
  if (!document) throw new ApiError('Upload an HTML page, a React component, or a TypeScript, JavaScript, Python or CSS file.', 415, 'UNSUPPORTED_TYPE')
  const agent = await prisma.agentTask.findFirst({
    where: { id: agentId, organizationId: auth.organizationId, status: { not: 'DELETED' }, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true },
  })
  if (!agent) throw new ApiError('Pick an agent you can use.', 404, 'AGENT_NOT_FOUND')
  const title = parsed.data.title || htmlTitleOf(document.content) || filename?.replace(/\.[a-z0-9]+$/i, '') || 'Uploaded page'
  const { artifact } = await createArtifact({
    organizationId: auth.organizationId,
    userId: auth.dbUser.id,
    // A page with scripts runs them (sandboxed, no network); a static one is a report.
    kind: document.kind,
    title,
    content: document.content,
    agentTaskId: agent.id,
  })
  return { success: true, artifactId: artifact.id, unsupportedScripts: unsupportedScripts(document.content) }
}, { permission: 'agent.write', maxBodyBytes: ARTIFACT_UPLOAD_MAX_BYTES + 200_000 })
