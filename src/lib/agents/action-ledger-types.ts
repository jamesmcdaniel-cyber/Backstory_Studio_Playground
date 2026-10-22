/**
 * One action-ledger entry as the UI receives it. Pure and client-safe.
 * Built by @/lib/agents/action-ledger-query; rendered by
 * @/components/agents/action-ledger.
 */

export type AgentActionStatus = 'done' | 'failed' | 'undoing' | 'undone'

export type AgentActionView = {
  id: string
  sourceKind: 'agent' | 'flow'
  agentTaskId: string | null
  flowId: string | null
  runId: string
  /** The person the call acted as. */
  actor: { id: string; name: string } | null
  /** Set when a person approved the write before it ran. */
  approvedBy: { id: string; name: string } | null
  provider: string
  plane: string
  tool: string
  /** The tool's name as a person reads it. */
  toolLabel: string
  /** The account it went out on: the runner's own, or the workspace's. */
  actsAs: 'user' | 'workspace' | 'service' | 'none' | null
  argsSummary: Record<string, unknown>
  /** The provider's reference to what was created (ids, ts, a link). */
  resultRef: Record<string, unknown> | null
  status: AgentActionStatus
  error: string | null
  undoError: string | null
  createdAt: string
  undoneAt: string | null
  undoneBy: { id: string; name: string } | null
  undo: {
    /** A compensator exists and this entry carries what it needs. */
    possible: boolean
    /** …and the person viewing may run it. */
    allowed: boolean
    /** What Undo does, when possible. */
    effect?: string
    /** Why not, when not possible or not allowed. */
    reason?: string
  }
}
