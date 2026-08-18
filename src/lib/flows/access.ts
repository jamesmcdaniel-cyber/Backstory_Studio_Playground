import { hashToken, timingSafeEqualHex } from '@/lib/crypto/secrets'
import { ApiError } from '@/lib/server/api-handler'

/**
 * Flow share roles (workbooks parity, v1): `visibility` gains 'view'.
 *   'shared'  — everyone in the org can see, run, and edit (the default).
 *   'view'    — everyone can see and run; only the OWNER edits/publishes.
 *   'private' — only the owner sees it at all (existing behavior).
 * Reads stay governed by agentVisibilityScope ('view' is visible because it
 * is not 'private'); WRITES call this guard.
 */

export function canEditFlow(flow: { visibility: string; userId: string | null }, userId: string): boolean {
  if (flow.visibility !== 'view') return true
  // Legacy ownerless rows stay editable by the org rather than by no one.
  return flow.userId === null || flow.userId === userId
}

export function assertFlowEditable(flow: { visibility: string; userId: string | null }, userId: string): void {
  if (canEditFlow(flow, userId)) return
  throw new ApiError('This flow is view-only — ask its owner to make changes.', 403, 'FLOW_VIEW_ONLY')
}

export type FlowRoleInput = {
  organizationId: string
  visibility: string
  userId: string | null
  /** SHA-256 of the live share token; the plaintext is never stored. */
  shareTokenDigest?: string | null
  shareRole?: string | null
  collaboratorRole?: string | null
}

/**
 * Does the presented raw token match the flow's stored digest?
 *
 * Hash-then-compare, in constant time. The digest is what the database holds,
 * so a leaked row cannot be replayed as a link, and the comparison cannot be
 * used to walk the token a byte at a time.
 */
export function shareTokenMatches(presented: string | null | undefined, digest: string | null | undefined): boolean {
  if (!presented || !digest) return false
  return timingSafeEqualHex(hashToken(presented), digest)
}

/**
 * The viewer's role on a flow, across workspace boundaries:
 *  1. Owner → edit, always.
 *  2. Same org → v1 semantics verbatim (shared=edit, view=view [legacy
 *     ownerless stays editable], private=owner-only).
 *  3. Cross-org: an accepted collaborator row's role wins; else a presented
 *     share token that matches grants the flow's shareRole.
 *  4. Otherwise null — the flow does not exist for this viewer.
 */
export function resolveFlowRole(
  flow: FlowRoleInput,
  viewer: { userId: string; organizationId: string },
  shareToken?: string | null,
): 'edit' | 'view' | null {
  if (flow.userId && flow.userId === viewer.userId) return 'edit'
  if (flow.organizationId === viewer.organizationId) {
    if (flow.visibility === 'private') return null
    if (flow.visibility === 'view') return flow.userId ? 'view' : 'edit'
    return 'edit'
  }
  if (flow.collaboratorRole === 'edit' || flow.collaboratorRole === 'view') return flow.collaboratorRole
  if (shareTokenMatches(shareToken, flow.shareTokenDigest)) return flow.shareRole === 'edit' ? 'edit' : 'view'
  return null
}
