/**
 * Draft and published, for agents.
 *
 * Editing an agent edited the LIVE agent: a tweak to an objective changed what
 * the next scheduled run did, immediately, with no staging and no review. Flows
 * have had the split since the beginning, and agents are the ones that act
 * through a person's own accounts and write to real systems.
 *
 * Pure. The runtime overlays a published definition onto the loaded row at one
 * point; everything downstream reads the same fields it always did and does not
 * know this exists.
 */

/** The fields that decide what an agent DOES. Not its bookkeeping. */
export type AgentDefinition = {
  description: string
  objective: string
  goal: string | null
  context: unknown
  schedule: unknown
  metadata: unknown
  /**
   * The connector keys bound when this was published, so publishing pins the
   * TOOLS as well as the words. Without it, adding a write-capable integration
   * to a published agent would change what it can do to the world with nothing
   * republished.
   */
  connectorKeys: string[]
}

export type PublishableAgent = {
  description: string
  objective: string
  goal?: string | null
  context?: unknown
  schedule?: unknown
  metadata?: unknown
  publishedConfig?: unknown
  publishedAt?: Date | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

/** The agent's current (draft) definition. */
export function agentDefinition(agent: PublishableAgent, connectorKeys: readonly string[] = []): AgentDefinition {
  return {
    description: agent.description,
    objective: agent.objective,
    goal: agent.goal ?? null,
    context: agent.context ?? {},
    schedule: agent.schedule ?? {},
    metadata: agent.metadata ?? null,
    connectorKeys: [...connectorKeys].sort(),
  }
}

/**
 * The published definition, or null when the agent has never been published.
 *
 * Null is the normal state for every agent that exists today, and it means "use
 * the live fields" — so adding this changed nothing for anyone until they
 * choose to publish.
 */
export function publishedDefinition(agent: PublishableAgent): AgentDefinition | null {
  const stored = agent.publishedConfig
  if (!isRecord(stored)) return null
  // A snapshot missing the two fields that decide what the agent says is not a
  // snapshot; falling back to live is safer than running half of one.
  if (typeof stored.objective !== 'string' || typeof stored.description !== 'string') return null
  return {
    description: stored.description,
    objective: stored.objective,
    goal: typeof stored.goal === 'string' ? stored.goal : null,
    context: stored.context ?? {},
    schedule: stored.schedule ?? {},
    metadata: stored.metadata ?? null,
    connectorKeys: Array.isArray(stored.connectorKeys) ? stored.connectorKeys.map(String) : [],
  }
}

/**
 * The row a run should execute against.
 *
 * Overlaid rather than replaced, so identity, ownership and status stay the
 * live ones: publishing pins what the agent DOES, never who it is or whether it
 * is allowed to run. Deactivating a published agent has to stop it.
 */
export function applyPublishedDefinition<T extends PublishableAgent>(agent: T): T & { publishedPinned: boolean } {
  const published = publishedDefinition(agent)
  if (!published) return { ...agent, publishedPinned: false }
  return {
    ...agent,
    description: published.description,
    objective: published.objective,
    goal: published.goal,
    context: published.context,
    schedule: published.schedule,
    metadata: published.metadata,
    publishedPinned: true,
  }
}

/** The connector keys a run may use: the published pin, or live when unpublished. */
export function pinnedConnectorKeys(agent: PublishableAgent): string[] | null {
  const published = publishedDefinition(agent)
  return published && published.connectorKeys.length ? published.connectorKeys : null
}

function stable(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical)
    if (isRecord(input)) {
      return Object.fromEntries(
        Object.entries(input)
          .filter(([, entry]) => entry !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      )
    }
    return input
  }
  return JSON.stringify(canonical(value) ?? null)
}

/**
 * Whether the draft has moved since it was published.
 *
 * What the editor needs to say "you have unpublished changes" — without it, a
 * published agent looks identical to an unpublished one and someone edits for
 * an hour wondering why nothing changes.
 */
export function hasUnpublishedChanges(agent: PublishableAgent, connectorKeys: readonly string[] = []): boolean {
  const published = publishedDefinition(agent)
  if (!published) return false
  return stable(published) !== stable(agentDefinition(agent, connectorKeys))
}
