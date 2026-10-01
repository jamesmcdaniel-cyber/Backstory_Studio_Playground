import type { Artifact } from '@prisma/client'
import { ApiError } from '@/lib/server/api-handler'
import type { AuthContext } from '@/lib/server/auth'
import { prisma } from '@/lib/prisma'
import { ArtifactAccessError, requireArtifactEdit, type ArtifactViewer } from './sharing'

/** The signed-in person, as the sharing rules see them. */
export function viewerOf(auth: AuthContext): ArtifactViewer {
  return { userId: auth.dbUser.id, can: (permission) => auth.can(permission) }
}

/** Personal template copies are not workspace-readable. */
export async function requireReadable(auth: AuthContext, artifactId: string) {
  const row = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId: auth.organizationId }, select: { userId: true, templateSourceId: true } })
  if (!row || (row.templateSourceId && row.userId !== auth.dbUser.id)) throw new ApiError('Artifact not found.', 404, 'NOT_FOUND')
}

/** The artifact when this person may change it — a 404, or a 403 naming why, when not. */
export async function requireEditable(auth: AuthContext, artifactId: string): Promise<Artifact> {
  try {
    return await requireArtifactEdit(auth.organizationId, artifactId, viewerOf(auth))
  } catch (error) {
    if (error instanceof ArtifactAccessError) throw new ApiError(error.message, error.status, error.status === 404 ? 'NOT_FOUND' : 'VIEW_ONLY')
    throw error
  }
}
