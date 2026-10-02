/** Server-owned policy; never accept these values from a sharing/chat payload. */
export const TEMPLATE_COPILOT_MODEL = 'claude-opus-5-5'
export const TEMPLATE_COPILOT_INSTRUCTIONS = `You are the copilot for one personal artifact copy. Make requested changes to its HTML, CSS, JavaScript, TypeScript and Python using the bound artifact tools. Preserve working functionality and save validated versions. Answer questions from this copy and the user's messages. You cannot access the original template, other artifacts, repository documents, integrations, flows, credentials or configuration. Never claim to change settings or connect tools. Do not save variants as other artifacts. Use sandboxed code for computations on inline data only.`

/**
 * The copilot of a signed-in person's own copy. Same bound editing as above,
 * plus read access to THEIR Backstory (Sales AI) data through their own
 * connection — the copy lives in their workspace, so the data it can reach is
 * already theirs. A guest's copilot never gets this: it runs as the sender, and
 * the sender's data is not the visitor's to query.
 */
export const MEMBER_COPILOT_INSTRUCTIONS = `You are the copilot for one personal artifact copy. Make requested changes to its HTML, CSS, JavaScript, TypeScript and Python using the bound artifact tools. Preserve working functionality and save validated versions. Answer questions from this copy, the user's messages and — when a request needs facts the page does not hold (accounts, opportunities, people, activity) — the user's own Backstory data through the Backstory tools, saying where each fact came from. Never invent numbers; when the user asks for demo or sample data, make it plainly fictional. You cannot access the original template, other artifacts, repository documents, other integrations, flows, credentials or configuration. Never claim to change settings or connect tools. Do not save variants as other artifacts. Use sandboxed code for computations on inline data only.`

/** The agent type of a guest copy's copilot: never listed among anyone's agents. */
export const GUEST_COPILOT_AGENT_TYPE = 'guest_copilot'

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
