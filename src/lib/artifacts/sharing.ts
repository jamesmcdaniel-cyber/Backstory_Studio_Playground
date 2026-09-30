import crypto from 'node:crypto'
import type { Artifact, Prisma } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { decryptSecret, encryptSecret, hashToken } from '@/lib/crypto/secrets'
import { rateLimit } from '@/lib/ratelimit'
import { recordAudit } from '@/lib/audit'
import { notify } from '@/lib/notifications/service'
import type { Permission } from '@/lib/authz/permissions'

/**
 * Who can see and change an artifact, and its public link.
 *
 * Everyone in the workspace can open an artifact (its link is the page URL).
 * Changing it — asking the assistant, restoring a version, archiving, its
 * settings, its sharing — takes edit access:
 *   - its creator, and workspace admins, always;
 *   - anyone named as an editor, whatever their role (a Viewer included);
 *   - members whose role can edit, unless workspace access is 'view'.
 * The default ('edit') is how artifacts behaved before sharing existed.
 *
 * The public link is opt-in and view-only: anyone holding it sees the current
 * version, sandboxed exactly as in the app, and nothing else — no assistant,
 * no history, no other artifact. Its token is a 192-bit bearer value stored
 * as a digest (for lookup) and encrypted (so an editor can copy it again).
 */

export type ArtifactViewer = { userId: string; can: (permission: Permission) => boolean }
export type WorkspaceAccess = 'edit' | 'view'
export type ArtifactPermissions = { canEdit: boolean; canShare: boolean; reason: 'owner' | 'admin' | 'editor' | 'workspace' | 'view_only' }

export class ArtifactAccessError extends Error {
  constructor(message: string, readonly status: 403 | 404) {
    super(message)
  }
}

export function editorIdsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
}

export function artifactPermissions(viewer: ArtifactViewer, artifact: Pick<Artifact, 'userId' | 'workspaceAccess' | 'editorIds'>): ArtifactPermissions {
  const grant = (reason: ArtifactPermissions['reason']): ArtifactPermissions => ({ canEdit: true, canShare: true, reason })
  if (artifact.userId && artifact.userId === viewer.userId) return grant('owner')
  if (viewer.can('org.manage')) return grant('admin')
  if (editorIdsOf(artifact.editorIds).includes(viewer.userId)) return grant('editor')
  if (artifact.workspaceAccess !== 'view' && viewer.can('agent.write')) return grant('workspace')
  return { canEdit: false, canShare: false, reason: 'view_only' }
}

/** The artifact, when this person may change it; otherwise a 404 or 403 with the reason. */
export async function requireArtifactEdit(organizationId: string, artifactId: string, viewer: ArtifactViewer): Promise<Artifact> {
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId } })
  if (!artifact) throw new ArtifactAccessError('Artifact not found.', 404)
  if (!artifactPermissions(viewer, artifact).canEdit) {
    throw new ArtifactAccessError('You can view this artifact but not change it. Ask its owner or an editor to share edit access.', 403)
  }
  return artifact
}

function newShareToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

export function publicArtifactUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/share/artifact/${token}`
}

type Person = { id: string; name: string | null; email: string | null }

export type ArtifactSharing = {
  workspaceAccess: WorkspaceAccess
  owner: Person | null
  editors: Person[]
  link: { enabled: boolean; url: string | null; views: number }
  permissions: ArtifactPermissions
}

async function people(organizationId: string, ids: string[]): Promise<Person[]> {
  if (!ids.length) return []
  const rows = await prisma.user.findMany({ where: { id: { in: ids }, organizationId }, select: { id: true, name: true, email: true } })
  return ids.map((id) => rows.find((row) => row.id === id)).filter((row): row is Person => Boolean(row))
}

function linkOf(artifact: Artifact, origin: string, freshToken?: string): ArtifactSharing['link'] {
  if (!artifact.shareAnonymous) return { enabled: false, url: null, views: artifact.anonymousViews }
  let token = freshToken ?? null
  if (!token && artifact.shareTokenCiphertext) {
    try {
      token = decryptSecret(artifact.shareTokenCiphertext)
    } catch {
      token = null
    }
  }
  return { enabled: true, url: token ? publicArtifactUrl(origin, token) : null, views: artifact.anonymousViews }
}

export async function loadSharing(organizationId: string, artifactId: string, viewer: ArtifactViewer, origin: string): Promise<ArtifactSharing | null> {
  const artifact = await prisma.artifact.findFirst({ where: { id: artifactId, organizationId } })
  if (!artifact) return null
  const permissions = artifactPermissions(viewer, artifact)
  const [owner] = await people(organizationId, artifact.userId ? [artifact.userId] : [])
  return {
    workspaceAccess: artifact.workspaceAccess === 'view' ? 'view' : 'edit',
    owner: owner ?? null,
    editors: await people(organizationId, editorIdsOf(artifact.editorIds)),
    // Only people who can share see the public link itself.
    link: permissions.canShare ? linkOf(artifact, origin) : { enabled: artifact.shareAnonymous, url: null, views: artifact.anonymousViews },
    permissions,
  }
}

export type SharingPatch = { workspaceAccess?: WorkspaceAccess; editorIds?: string[]; link?: 'enable' | 'disable' | 'rotate' }

/** Change who can edit, or the public link. Newly added editors are notified; every change is audited. */
export async function updateSharing(organizationId: string, artifactId: string, viewer: ArtifactViewer, origin: string, patch: SharingPatch): Promise<ArtifactSharing> {
  const artifact = await requireArtifactEdit(organizationId, artifactId, viewer)
  const data: Prisma.ArtifactUpdateInput = {}
  let freshToken: string | undefined
  let added: string[] = []

  if (patch.workspaceAccess) data.workspaceAccess = patch.workspaceAccess
  if (patch.editorIds) {
    // Only people in this workspace can be editors.
    const members = await prisma.user.findMany({ where: { id: { in: [...new Set(patch.editorIds)] }, organizationId }, select: { id: true } })
    const next = members.map((member) => member.id).filter((id) => id !== artifact.userId).slice(0, 200)
    const before = new Set(editorIdsOf(artifact.editorIds))
    added = next.filter((id) => !before.has(id))
    data.editorIds = next
  }
  if (patch.link === 'enable' && !artifact.shareAnonymous || patch.link === 'rotate') {
    freshToken = newShareToken()
    let ciphertext: string | null = null
    try {
      ciphertext = encryptSecret(freshToken)
    } catch {
      ciphertext = null // without encryption the link is shown once, like a flow's
    }
    data.shareAnonymous = true
    data.shareTokenDigest = hashToken(freshToken)
    data.shareTokenCiphertext = ciphertext
  } else if (patch.link === 'disable') {
    data.shareAnonymous = false
    data.shareTokenDigest = null
    data.shareTokenCiphertext = null
  }

  const updated = await prisma.artifact.update({ where: { id: artifactId, organizationId }, data })

  await recordAudit({
    organizationId,
    actorUserId: viewer.userId,
    action: patch.link === 'enable' || patch.link === 'rotate' ? 'artifact.public_link_enabled' : patch.link === 'disable' ? 'artifact.public_link_disabled' : 'artifact.sharing_changed',
    resourceType: 'artifact',
    resourceId: artifactId,
    detail: {
      ...(patch.workspaceAccess ? { workspaceAccess: patch.workspaceAccess } : {}),
      ...(patch.editorIds ? { editors: editorIdsOf(updated.editorIds).length, added: added.length } : {}),
      ...(patch.link ? { link: patch.link } : {}),
    },
  })

  if (added.length) {
    const actor = await prisma.user.findFirst({ where: { id: viewer.userId, organizationId }, select: { name: true, email: true } })
    const who = actor?.name || actor?.email || 'Someone'
    for (const userId of added) {
      await notify({ organizationId, userId, type: 'artifact.shared', level: 'info', title: `${who} shared "${updated.title}" with you`, body: 'You can view it and ask its assistant for changes.', link: `/artifacts/${artifactId}` })
    }
  }

  const sharing = await loadSharing(organizationId, artifactId, viewer, origin)
  if (!sharing) throw new ArtifactAccessError('Artifact not found.', 404)
  // A link minted without encryption can only be shown now.
  if (freshToken && !sharing.link.url) sharing.link = { enabled: true, url: publicArtifactUrl(origin, freshToken), views: updated.anonymousViews }
  return sharing
}

export type PublicArtifact = { id: string; organizationId: string; title: string; kind: string; updatedAt: Date; currentVersionId: string | null }
export type PublicArtifactResult = { status: 'ok'; artifact: PublicArtifact } | { status: 'not_found' } | { status: 'rate_limited' }

const ANON_LIMIT = { limit: 60, windowMs: 60_000 }

/**
 * The only path that serves an artifact to someone with no session. Keyed on
 * the digest of what the visitor presented, and only while the link is on.
 */
export async function resolvePublicArtifact(token: string, options: { clientKey: string; countView?: boolean }): Promise<PublicArtifactResult> {
  if (!token || token.length < 16) return { status: 'not_found' }
  const limited = await rateLimit(`artifact-anon-share:${options.clientKey}`, ANON_LIMIT)
  if (!limited.ok) return { status: 'rate_limited' }
  // systemPrisma: an anonymous visitor has no organization to scope by. The
  // lookup is the unique digest of a 192-bit token AND requires the link to be
  // on — an artifact nobody shared is unreachable, and nothing else is queryable.
  const artifact = await systemPrisma.artifact.findFirst({
    where: { shareTokenDigest: hashToken(token), shareAnonymous: true, archivedAt: null },
    select: { id: true, organizationId: true, title: true, kind: true, updatedAt: true, currentVersionId: true },
  })
  if (!artifact) return { status: 'not_found' }
  if (options.countView) {
    await systemPrisma.artifact.update({ where: { id: artifact.id }, data: { anonymousViews: { increment: 1 } } }).catch(() => undefined)
  }
  return { status: 'ok', artifact }
}
