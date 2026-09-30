import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { prisma } from '@/lib/prisma'
import { archiveArtifact, loadArtifact } from '@/lib/artifacts/service'
import { artifactPermissions } from '@/lib/artifacts/sharing'
import { requireEditable, viewerOf } from '@/lib/artifacts/route-access'
import { attachArtifactAgent } from '@/lib/artifacts/artifact-agent'

export const runtime = 'nodejs'

function idOf(request: Request): string {
  const id = new URL(request.url).pathname.split('/').at(-1)
  if (!id) throw new ApiError('Artifact id is required.', 400, 'ID_REQUIRED')
  return id
}

// GET /api/artifacts/:id — the artifact, its versions and conversation (pending answers reconciled).
export const GET = withAuthenticatedApi(async (request, auth) => {
  const id = idOf(request)
  const artifact = await loadArtifact(auth.organizationId, id)
  if (!artifact) throw new ApiError('Artifact not found.', 404, 'NOT_FOUND')
  const row = await prisma.artifact.findFirst({ where: { id, organizationId: auth.organizationId }, select: { userId: true, workspaceAccess: true, editorIds: true } })
  // What this person may do with it: the viewer hides what they can't.
  return { success: true, artifact: { ...artifact, permissions: row ? artifactPermissions(viewerOf(auth), row) : null } }
}, { permission: 'agent.read' })

// PATCH /api/artifacts/:id — archive or unarchive, or set the agent behind
// it: an existing one ({ agentId }) or a new one made for it ({ createAgent }).
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const id = idOf(request)
  const parsed = z.object({ archived: z.boolean().optional(), agentId: z.string().min(1).max(64).optional(), createAgent: z.boolean().optional() })
    .refine((body) => body.archived !== undefined || body.agentId || body.createAgent, 'Send archived, agentId or createAgent.')
    .safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError(parsed.error.issues[0]?.message ?? 'Send archived, agentId or createAgent.', 400, 'INVALID_BODY')
  await requireEditable(auth, id)
  if (parsed.data.archived !== undefined) await archiveArtifact(auth.organizationId, id, parsed.data.archived)
  if (parsed.data.agentId || parsed.data.createAgent) {
    try {
      const agent = await attachArtifactAgent({ organizationId: auth.organizationId, userId: auth.dbUser.id, artifactId: id, agentId: parsed.data.agentId, create: parsed.data.createAgent })
      return { success: true, agent }
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : 'The agent could not be attached.', 400, 'AGENT_REJECTED')
    }
  }
  return { success: true }
}, { permission: 'agent.read' })
