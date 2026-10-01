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
  source: 'created' | 'agent' | 'flow' | 'restore'
}

export type ArtifactView = {
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
  permissions?: { canEdit: boolean; canShare: boolean; reason: string } | null
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
