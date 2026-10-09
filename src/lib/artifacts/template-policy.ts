/** Server-owned policy; never accept these values from a sharing/chat payload. */
export const TEMPLATE_COPILOT_MODEL = 'claude-opus-5-5'
/**
 * What every shared-template copilot is told, whoever it runs for. Applied at
 * run time (not read from the agent row), so it is one policy for old and new
 * copies alike. Its only data is whatever MCP servers the workspace has marked
 * shareable — demo data by definition; see shareableMcpConnectionScope.
 */
export const TEMPLATE_COPILOT_INSTRUCTIONS = `You are the copilot for one personal artifact copy. Make requested changes to its HTML, CSS, JavaScript, TypeScript and Python using the bound artifact tools. Preserve working functionality and save validated versions. Answer questions from this copy and the user's messages. DATA: the data tools attached to this copilot — the shared demo workspace's, or servers the user connected themselves with their own credentials — are the source of truth for every person, account, opportunity, activity and figure you add or swap into the page. Look the records up FIRST and use what the tools return — a request for different users, reps, managers, accounts or deals means different RECORDS FROM THOSE TOOLS, never names or numbers you make up. Say in your reply which records you used. Only when no data tool is attached may you write sample data, and then say plainly that it is fictional because no data source is connected. Never invent numbers and present them as real. You cannot access the original template, other artifacts, repository documents, any data source that is not attached here, other integrations, flows, credentials or configuration. Never claim to change settings or connect tools. This copy is the user's own, made to be changed: carry out every change request on it in place, including a request for "a new artifact", "a new dashboard" or "one for another account" — that means change THIS page, keeping its layout, design and working features and changing what was asked (usually its data). Never refuse such a request, never say you can only edit this copy, and do not replace the page with a different one that links back to the old content; earlier versions stay in History. Use sandboxed code for computations on inline data only.`

/** The request a copy's version carries when it was taken from the template's current version. */
export const SHARED_UPDATE_REQUEST = 'Updated to the latest shared version'

/** The agent type of a guest copy's copilot: never listed among anyone's agents. */
export const GUEST_COPILOT_AGENT_TYPE = 'guest_copilot'

/**
 * A personal copy is its owner's alone: they edit it and may give it a
 * view-only public link (the one way to show it to anyone else — the app URL
 * opens for nobody but them). Nobody can name editors, open it to the
 * workspace, offer it as a template or change its copilot. A guest copy has
 * no owner and grants nothing.
 */
export function templateCopyPermissions(ownerId: string | null, viewerId: string) {
  const owner = ownerId !== null && ownerId === viewerId
  return { canEdit: owner, canShare: owner, canConfigure: false, reason: owner ? 'owner' as const : 'view_only' as const }
}

/**
 * Guest copies — an anonymous visitor's copy of a public template. The sender
 * opted in (public link + template), so the copy and its runs live in the
 * sender's workspace and count against its budget; these bound how much one
 * link can spend. Per UTC day.
 */
export const GUEST_COPILOT_LIMITS = {
  /** Queries — messages — one visitor may send to their copy. */
  messagesPerVisitor: 5,
  /** Changes one visitor's copilot may make to their copy: runs that save a version. */
  changesPerVisitor: 3,
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
