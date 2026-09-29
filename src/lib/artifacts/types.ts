/**
 * Wire types for the Artifacts pages — a leaf module the client imports.
 */

export type ArtifactKind = 'report' | 'roi_dashboard' | 'document'

export type ArtifactChatMessage = {
  role: 'user' | 'agent'
  /** 'ask' answers in prose; 'change' asks for a new version. */
  mode?: 'ask' | 'change'
  content: string
  executionId?: string
  flowRunId?: string
  /** Set on an agent message once its run produced a version. */
  versionId?: string
  status?: 'pending' | 'completed' | 'failed'
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
  chat: ArtifactChatMessage[]
  /** Whether a scripted (interactive) sandbox is allowed for this kind. */
  interactive: boolean
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ArtifactListItem = Pick<ArtifactView, 'id' | 'kind' | 'title' | 'agent' | 'flow' | 'versionCount' | 'updatedAt' | 'createdAt'>

export const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
  report: 'Report',
  roi_dashboard: 'ROI dashboard',
  document: 'Document',
}
