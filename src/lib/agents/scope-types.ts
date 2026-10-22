/**
 * "What this agent can do" — the shape the scope card renders.
 *
 * Pure and client-safe: the server builds an AgentScope from the runtime's own
 * tool resolution (@/features/agents/agent-scope), the card components render
 * it (@/components/agents/agent-scope-card). Kept separate from both so a
 * future surface — an external agent shown as a teammate — can produce the same
 * shape from its own source and reuse the card unchanged.
 */

/** What a tool does to the world, as the runtime classifies it. */
export type ScopeToolAccess =
  /** Changes nothing outside Backstory. */
  | 'read'
  /** Sends, creates or changes something. */
  | 'write'
  /** Decided per call (a warehouse query: SELECT reads, DELETE writes). */
  | 'depends'
  /** An MCP server that doesn't say whether its tool changes anything. */
  | 'unclassified'

export type ScopeTool = {
  /** The tool's own name on its connection. */
  name: string
  /** The same name as a person reads it. */
  label: string
  access: ScopeToolAccess
  /**
   * allowed        — runs when the agent calls it;
   * needs_approval — queued for a person first;
   * blocked        — never handed to a run.
   */
  status: 'allowed' | 'needs_approval' | 'blocked'
  /** Why approval: the agent's own setting, or "Needs approval" in Integrations. */
  approvalBy?: 'agent' | 'integration'
  /** Why blocked: turned off in Integrations, or left off this agent's tool list. */
  blockedBy?: 'integration' | 'agent'
  /** For writes: whether a write can be undone from the action ledger. */
  undo?: { undoable: boolean; note: string }
}

/** Whose account a connection's calls go out on. */
export type ScopeActsAs = 'user' | 'workspace' | 'service' | 'none'

export type ScopeConnection = {
  /** Stable key for the connection within this scope. */
  key: string
  name: string
  /** 'people_ai' | 'mcp' | 'native' | 'nango' — and 'external' for a reuser's own source. */
  plane: string
  actsAs: ScopeActsAs
  /** Attached, but no usable connection resolved for this run. */
  unavailable?: string
  tools: ScopeTool[]
}

export type ScopeCounts = {
  connections: number
  /** Tools a run is handed (allowed + needs approval). */
  tools: number
  reads: number
  /** Includes per-call ('depends') tools. */
  writes: number
  needsApproval: number
  blocked: number
}

export type ScopeTrigger =
  | { kind: 'schedule'; description: string }
  | { kind: 'webhook' }
  | { kind: 'signal'; description: string }
  | { kind: 'slack_channel'; count: number }
  | { kind: 'slack_command'; command: string }

export type AgentScope = {
  agentId: string
  /** Whose view this is: the scope is resolved for the person asking. */
  resolvedFor: 'viewer'
  counts: ScopeCounts
  connections: ScopeConnection[]
  identity: {
    /** Who a scheduled or signal-started run acts as — the agent's owner. */
    ownerName: string | null
  }
  approval: {
    /** The agent's own "Ask before acting" setting. */
    agentRequiresApproval: boolean
    /** Write connections that setting does NOT hold back (the runtime gate doesn't cover them). */
    notCoveredByAgentApproval: string[]
  }
  data: {
    /** Repository: workspace-wide documents are always readable. */
    agentDocuments: number
    collections: Array<{ id: string; name: string }>
  }
  triggers: ScopeTrigger[]
  /** Facts a person should know that are not per-tool. */
  notes: string[]
}

/** The compact form a roster card shows. */
export type AgentScopeSummary = {
  counts: ScopeCounts
  /** At least one connection acts as the person running it. */
  actsAsRunner: boolean
  agentRequiresApproval: boolean
  scheduled: boolean
  triggerCount: number
}

export function countScope(connections: ScopeConnection[]): ScopeCounts {
  const counts: ScopeCounts = { connections: 0, tools: 0, reads: 0, writes: 0, needsApproval: 0, blocked: 0 }
  for (const connection of connections) {
    counts.connections += 1
    for (const tool of connection.tools) {
      if (tool.status === 'blocked') {
        counts.blocked += 1
        continue
      }
      counts.tools += 1
      if (tool.status === 'needs_approval') counts.needsApproval += 1
      if (tool.access === 'write' || tool.access === 'depends') counts.writes += 1
      else if (tool.access === 'read') counts.reads += 1
    }
  }
  return counts
}

export function summarizeScope(scope: AgentScope): AgentScopeSummary {
  return {
    counts: scope.counts,
    actsAsRunner: scope.connections.some((connection) => connection.actsAs === 'user' && !connection.unavailable),
    agentRequiresApproval: scope.approval.agentRequiresApproval,
    scheduled: scope.triggers.some((trigger) => trigger.kind === 'schedule'),
    triggerCount: scope.triggers.length,
  }
}
