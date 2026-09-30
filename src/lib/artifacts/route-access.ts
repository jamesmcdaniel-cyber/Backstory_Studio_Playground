import type { Artifact } from '@prisma/client'
import { ApiError } from '@/lib/server/api-handler'
import type { AuthContext } from '@/lib/server/auth'
import { ArtifactAccessError, requireArtifactEdit, type ArtifactViewer } from './sharing'

/** The signed-in person, as the sharing rules see them. */
export function viewerOf(auth: AuthContext): ArtifactViewer {
  return { userId: auth.dbUser.id, can: (permission) => auth.can(permission) }
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
