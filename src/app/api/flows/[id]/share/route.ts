import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { agentVisibilityScope } from '@/lib/server/visibility'
import { assertFlowEditable } from '@/lib/flows/access'
import { hashToken } from '@/lib/crypto/secrets'
import { recordAudit } from '@/lib/audit'

const bodySchema = z.object({
  enabled: z.boolean(),
  role: z.enum(['view', 'edit']).default('view'),
  rotate: z.boolean().optional(),
  // Also delete the ACCEPTED collaborator rows (durable grants a rotate alone
  // deliberately keeps) — "rotate and remove everyone who joined by link".
  revokeCollaborators: z.boolean().optional(),
  // The no-sign-in public link is NOT this token any more — it lives at
  // /api/flows/[id]/public-link with its own token. A stray `anonymous` field
  // from an old client is ignored rather than re-coupling the two.
})

// POST /api/flows/[id]/share — manage the cross-workspace JAM link (signed-in
// collaborators; the public no-sign-in link is ./public-link). Only a
// same-org EDITOR may manage sharing (the org-scoped lookup below is that
// wall — guests can never reach this). Enabling mints a token when none
// exists and otherwise keeps it (so changing the role doesn't break sent
// links); `rotate: true` forces a fresh token (old links stop working);
// disabling clears it. Rotation does NOT remove already-accepted
// collaborators — their rows are durable grants.
//
// Only the DIGEST is stored, so the raw token exists only in this response, at
// the moment it is minted or rotated. A caller that loses it rotates for a new
// one; nothing — not this API, not a database read — can recover the old value.
export const POST = withAuthenticatedApi(async (request, auth) => {
  const id = request.nextUrl.pathname.split('/').at(-2)
  if (!id) throw new ApiError('Flow id is required')
  const flow = await prisma.flow.findFirst({
    where: { id, organizationId: auth.organizationId, ...agentVisibilityScope(auth.dbUser.id) },
    select: { id: true, visibility: true, userId: true, shareTokenDigest: true },
  })
  if (!flow) throw new ApiError('Flow not found', 404, 'NOT_FOUND')
  assertFlowEditable(flow, auth.dbUser.id)
  const { enabled, role, rotate, revokeCollaborators } = bodySchema.parse(await request.json())
  // Only a MINT produces a raw token, and this response is the one and only
  // place it is ever readable: the database keeps the digest, so a role change
  // on an existing link (which deliberately keeps the link working) simply has
  // no plaintext to return.
  const minted = !enabled ? null : rotate || !flow.shareTokenDigest ? randomBytes(16).toString('hex') : null
  const shareTokenDigest = !enabled ? null : minted ? hashToken(minted) : flow.shareTokenDigest
  const updated = await prisma.flow.update({
    where: { id: flow.id, organizationId: auth.organizationId },
    data: { shareTokenDigest, shareRole: role },
  })
  let revoked = 0
  if (revokeCollaborators) {
    // Deleting the rows revokes both the app role and the realtime topics
    // (flow_topic_access reads flow_collaborators) on the guests' next check.
    const result = await prisma.flowCollaborator.deleteMany({
      where: { flow: { id: flow.id, organizationId: auth.organizationId } },
    })
    revoked = result.count
  }
  void recordAudit({
    organizationId: auth.organizationId,
    actorUserId: auth.dbUser.id,
    action: enabled ? 'flow.share_link_enabled' : 'flow.share_link_disabled',
    resourceType: 'flow',
    resourceId: flow.id,
    detail: { role, rotated: Boolean(rotate), revokedCollaborators: revoked },
  }).catch(() => undefined)
  return {
    success: true,
    // Shown once. Null when the link was left alone (a role change) or
    // turned off — the caller keeps the copy it was given at mint.
    shareToken: minted,
    shareEnabled: Boolean(updated.shareTokenDigest),
    shareRole: updated.shareRole === 'edit' ? 'edit' : 'view',
    // The public link's state, unchanged by this route, so the jam panel's
    // audience stays accurate after any change it makes here.
    shareAnonymous: updated.shareAnonymous,
    anonymousViews: updated.anonymousViews,
    revokedCollaborators: revoked,
  }
}, { permission: 'flow.write' })
