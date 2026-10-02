import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { ArtifactAccessError, loadSharing, SharingInputError, updateSharing } from '@/lib/artifacts/sharing'
import { requireReadable, viewerOf } from '@/lib/artifacts/route-access'

export const runtime = 'nodejs'

function artifactIdOf(request: Request): string {
  const id = new URL(request.url).pathname.split('/').at(-2)
  if (!id) throw new ApiError('Artifact id is required.', 400, 'ID_REQUIRED')
  return id
}

function originOf(request: Request): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.trim() || new URL(request.url).origin).replace(/\/$/, '')
}

// GET /api/artifacts/:id/sharing — who can edit, workspace access, and the
// public link (its URL only for people who can share).
export const GET = withAuthenticatedApi(async (request, auth) => {
  await requireReadable(auth, artifactIdOf(request))
  const sharing = await loadSharing(auth.organizationId, artifactIdOf(request), viewerOf(auth), originOf(request))
  if (!sharing) throw new ApiError('Artifact not found.', 404, 'NOT_FOUND')
  return { success: true, ...sharing }
}, { permission: 'agent.read' })

const patchSchema = z.object({
  shareTemplate: z.boolean().optional(),
  workspaceAccess: z.enum(['edit', 'view']).optional(),
  editorIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  link: z.enum(['enable', 'disable', 'rotate']).optional(),
  // When the public link stops working; null = never.
  linkExpiresAt: z.string().datetime().nullable().optional(),
})

// PATCH /api/artifacts/:id/sharing — change workspace access, the editors, or
// the public link. Anyone who can edit the artifact can share it.
export const PATCH = withAuthenticatedApi(async (request, auth) => {
  const parsed = patchSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) throw new ApiError(parsed.error.issues[0]?.message ?? 'Send workspaceAccess, editorIds or link.', 400, 'INVALID_BODY')
  try {
    const sharing = await updateSharing(auth.organizationId, artifactIdOf(request), viewerOf(auth), originOf(request), parsed.data)
    return { success: true, ...sharing }
  } catch (error) {
    if (error instanceof ArtifactAccessError) throw new ApiError(error.message, error.status, error.status === 404 ? 'NOT_FOUND' : 'VIEW_ONLY')
    if (error instanceof SharingInputError) throw new ApiError(error.message, 400, 'INVALID_EXPIRY')
    throw error
  }
}, { permission: 'agent.read' })
