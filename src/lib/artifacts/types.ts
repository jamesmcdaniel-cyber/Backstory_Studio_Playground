/**
 * Wire types for the Artifacts pages — a leaf module the client imports.
 */

export type ArtifactKind = 'report' | 'roi_dashboard' | 'document' | 'page'

export type ArtifactChatMessage = {
  role: 'user' | 'agent'
  /** 'auto' lets the assistant decide; 'ask' and 'change' are explicit hints. */
  mode?: 'auto' | 'ask' | 'change'
  content: string
  executionId?: string
  flowRunId?: string
  /** Set on an agent message once its run produced a version. */
  versionId?: string
  status?: 'pending' | 'completed' | 'failed'
  /** Set on a pending agent message while its run is paused on a question for
   *  the person; answering it (the artifact's reply route) resumes the run. */
  question?: string
  /** The question already answered on this message (its tool-call id), so it
   *  is not asked again while the resume is still being picked up. */
  answeredQuestionId?: string
  /** The model that answered, when one was picked. */
  model?: string
  createdAt: string
}

export type ArtifactVersionView = {
  id: string
  number: number
  executionId: string | null
  flowRunId: string | null
  request: string | null
  createdAt: string
  bytes: number
  /** How the viewer shows it: a sandboxed frame, or rendered Markdown. */
  format: 'html' | 'markdown'
  /** Who asked for it (the person whose message or click made it). */
  author: string | null
  /** How it came to be. */
  /** 'shared': a template copy's version taken from the original's current one. */
  source: 'created' | 'agent' | 'flow' | 'restore' | 'shared'
}

export type ArtifactView = {
  /** Server-owned lock, included in chat/restore responses as well as GET. */
  configurationLocked?: boolean
  id: string
  kind: ArtifactKind
  title: string
  agent: { id: string; title: string } | null
  flow: { id: string; name: string; active: boolean } | null
  currentVersionId: string | null
  versionCount: number
  versions: ArtifactVersionView[]
  nextVersionBefore?: number | null
  chat: ArtifactChatMessage[]
  /** Whether a scripted (interactive) sandbox is allowed for this kind. */
  interactive: boolean
  /** An ROI dashboard's build: the run while it works, or why it failed. */
  build: { status: string; executionId: string | null; error: string | null; account: string } | null
  archivedAt: string | null
  /** What the person viewing may do (sent by GET /api/artifacts/:id). */
  permissions?: { canEdit: boolean; canShare: boolean; canConfigure?: boolean; reason: string } | null
  createdAt: string
  updatedAt: string
}

export type ArtifactListItem = Pick<ArtifactView, 'id' | 'kind' | 'title' | 'agent' | 'flow' | 'versionCount' | 'updatedAt' | 'createdAt' | 'archivedAt'>

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
  report: 'Report',
  roi_dashboard: 'ROI dashboard',
  document: 'Document',
  page: 'Interactive page',
}

/** The cookie holding an anonymous visitor's token for their guest copies. */
export const GUEST_COOKIE = 'bs_guest'

/** A server the person using a shared-template copy connected for its copilot. Never carries a secret. */
export type CopilotMcpServerView = { id: string; name: string; description?: string; serverUrl: string; authType: 'none' | 'api_key' | 'oauth2'; toolCount: number }

/** What a visitor sees of their guest copy: no run ids, models or raw run errors. */
export type GuestCopilotView = {
  copyId: string
  title: string
  versionId: string | null
  /** Whether the copilot has changed the copy yet; until then it is the original. */
  edited: boolean
  /** The template's original has a newer version than this copy took (its ISO time), or null. */
  sharedUpdate: string | null
  /** Today's allowance: queries sent and changes made, against the visitor limits. */
  usage: { queries: { used: number; limit: number }; changes: { used: number; limit: number } }
  /** MCP servers the visitor connected themselves; once any exist the copilot uses only these. */
  mcpServers: CopilotMcpServerView[]
  /** The copy's recent versions, newest first — the visitor's own history. */
  versions: Array<Pick<ArtifactVersionView, 'id' | 'number' | 'request' | 'createdAt' | 'source'>>
  /** A reply that changed the copy carries that version's id, so it can be viewed from the chat. */
  chat: Array<Pick<ArtifactChatMessage, 'role' | 'content' | 'status' | 'createdAt' | 'question' | 'versionId'>>
}
