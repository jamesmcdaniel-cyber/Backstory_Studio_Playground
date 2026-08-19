/**
 * Typed accessor for the `AgentTask.metadata` JSON grab-bag. Every field that
 * lives in metadata is declared here once, so reads stop scattering ad-hoc
 * `as any` casts across routes and workers (and stop silently drifting).
 */
export type AgentMetadata = {
  title?: string
  description?: string
  model?: string
  integrations?: string[]
  skills?: string[]
  icon?: string
  /** AI-generated 1–2 word role ("Deal Researcher") shown on the agents gallery.
   *  Cleared whenever title/description/instructions change so it regenerates. */
  roleLabel?: string
  /** Chosen avatar seed; null/absent derives the face from the agent id. */
  avatarSeed?: string
  maxTurns?: number
  headline?: string
  triggerSecretHash?: string
  /** Legacy plaintext trigger secret (superseded by triggerSecretHash). */
  triggerSecret?: string
  pendingQuestion?: unknown
  allowSubagents?: boolean
  subagentIds?: string[]
  /** Lets this agent run published flows via the run_flow tool. */
  allowFlows?: boolean
  /** Restrict which flows it may run. Empty/omitted = any visible published flow. */
  flowIds?: string[]
  /** When true, a question closely matching a past answer is auto-answered from memory. */
  autoAnswerFromMemory?: boolean
  /** When true, every run starts with an explicit numbered plan before any tool call. */
  alwaysStrategize?: boolean
  /** When true, outbound write-tool calls are queued for human approval instead
   *  of executing inline. See @/lib/agents/approval. */
  requireApproval?: boolean
  /** Configured API endpoints (agent setup → HTTP API) — each one surfaces as
   *  a named tool at run time. Validated by parseAgentHttpEndpoints on read. */
  httpEndpoints?: unknown[]
  /** AI-proposed goal surfaced from a run's reflection pass, pending user confirmation. */
  suggestedGoal?: string
  /** Per-tool scopes (Slack channels, GitHub repos…) keyed by quick-config key.
   *  Validated by parseAgentToolSettings on read; empty list = unrestricted. */
  toolSettings?: unknown
}

/** Parse an unknown JSON value into a typed AgentMetadata (never throws). */
export function readAgentMetadata(value: unknown): AgentMetadata {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AgentMetadata)
    : {}
}
