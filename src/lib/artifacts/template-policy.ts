/** Server-owned policy; never accept these values from a sharing/chat payload. */
export const TEMPLATE_COPILOT_MODEL = 'claude-opus-5-5'
export const TEMPLATE_COPILOT_INSTRUCTIONS = `You are the copilot for one personal artifact copy. Make requested changes to its HTML, CSS, JavaScript, TypeScript and Python using the bound artifact tools. Preserve working functionality and save validated versions. Answer questions from this copy and the user's messages. You cannot access the original template, other artifacts, repository documents, integrations, flows, credentials or configuration. Never claim to change settings or connect tools. Do not save variants as other artifacts. Use sandboxed code for computations on inline data only.`

export function templateCopyPermissions(ownerId: string | null, viewerId: string) {
  return { canEdit: ownerId === viewerId, canShare: false, canConfigure: false, reason: ownerId === viewerId ? 'owner' as const : 'view_only' as const }
}

/**
 * Guest copies — an anonymous visitor's copy of a public template. The sender
 * opted in (public link + template), so the copy and its runs live in the
 * sender's workspace and count against its budget; these bound how much one
 * link can spend. Per UTC day.
 */
export const GUEST_COPILOT_LIMITS = {
  /** Messages one visitor may send to their copy. */
  messagesPerVisitor: 10,
  /** Messages all visitors together may send through one template link. */
  messagesPerTemplate: 100,
  /** New guest copies one template link may create. */
  copiesPerTemplate: 50,
} as const

/**
 * Whether a run by `runUserId` may work on this copy. A personal copy: only
 * its owner. A guest copy has no owner — its copilot runs as the host (the
 * template's owner), and what binds a run to it is the copy↔copilot pairing,
 * which every caller checks alongside this.
 */
export function templateCopyRunsAs(copy: { userId: string | null; guestDigest?: string | null }, runUserId: string): boolean {
  return copy.userId ? copy.userId === runUserId : Boolean(copy.guestDigest)
}
