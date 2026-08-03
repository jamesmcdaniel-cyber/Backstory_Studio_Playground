/**
 * Typed AgentConnector bindings — the read/write bridge between an agent's
 * selected integrations and the connector registry.
 *
 * The agent form still stores its selection as `metadata.integrations` (a string
 * array, also read by the AI draft/chat proposal surfaces and templates). On
 * every create/update we ALSO project that selection into typed AgentConnector
 * rows: a canonical key, its plane (kind), and — when the selection names a
 * per-org MCP connection — a real foreign key. This gives referential integrity
 * (deleting a connection nulls its bindings) and queryability ("which agents use
 * this connection?"), while the runtime read path prefers the typed rows and
 * falls back to `metadata.integrations` for any not-yet-synced agent.
 */
import { prisma, systemPrisma, tenantTransaction } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { BUILTIN_CONNECTORS } from './registry'

/**
 * Classify one selected integration key into a typed binding: its plane (kind)
 * and, when the key names a per-org MCP connection, that connection's id. Pure —
 * unit-testable without a DB. `connectorKey` is preserved verbatim so the
 * runtime's registry matching activates exactly the same planes as before.
 */
export function classifyConnector(
  key: string,
  idByName: Map<string, string>,
): { connectorKey: string; kind: string; mcpConnectionId: string | null } {
  const builtin = BUILTIN_CONNECTORS.find((c) => c.matches(key))
  const mcpConnectionId = idByName.get(key.toLowerCase()) ?? null
  const kind = builtin ? builtin.kind : mcpConnectionId ? 'mcp' : 'external'
  return { connectorKey: key, kind, mcpConnectionId }
}

/**
 * Replace an agent's typed connector bindings to match its selected integration
 * keys. Best-effort: a failure here must not fail the agent save (the runtime
 * still resolves via the metadata fallback).
 */
export async function syncAgentConnectors(
  agentTaskId: string,
  organizationId: string,
  integrations: string[],
): Promise<void> {
  try {
    const keys = Array.from(new Set(integrations.map((s) => s.trim()).filter(Boolean)))
    const connections = await prisma.mcpConnection.findMany({
      where: { organizationId, isActive: true },
      select: { id: true, name: true },
    })
    const idByName = new Map(connections.map((c) => [c.name.toLowerCase(), c.id]))

    const rows = keys.map((key) => ({ agentTaskId, organizationId, ...classifyConnector(key, idByName) }))

    // Atomic replace: the current selection is the whole truth for this agent.
    await tenantTransaction(organizationId, async (tx) => {
      // Org-scoped: the tenant guard rejects an unscoped delete, and the catch
      // below only warns — unscoped, every sync failed silently and the runtime
      // fell back to the metadata list for good.
      await tx.agentConnector.deleteMany({ where: { agentTaskId, organizationId } })
      if (rows.length) await tx.agentConnector.createMany({ data: rows })
    })
  } catch (error) {
    apiLogger.warn('syncAgentConnectors failed; runtime will use the metadata fallback', {
      agentTaskId, organizationId, error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * The connector keys that gate an agent's tool loading. Prefers the typed
 * AgentConnector rows; falls back to `metadata.integrations` for agents created
 * before the FK existed (or if the last sync failed).
 */
export async function resolveAgentConnectorKeys(
  agentTaskId: string,
  metadata: Record<string, unknown> | null | undefined,
): Promise<string[]> {
  const fromMetadata = () => {
    const integrations = (metadata as { integrations?: unknown } | null | undefined)?.integrations
    return Array.isArray(integrations) ? integrations.map(String) : []
  }
  try {
    // systemPrisma: keyed by globally-unique agentTaskId (org-determined); resolved during execution setup.
    const rows = await systemPrisma.agentConnector.findMany({
      where: { agentTaskId },
      select: { connectorKey: true },
    })
    if (rows.length) return rows.map((r) => r.connectorKey)
    return fromMetadata()
  } catch (error) {
    // Deploy-order safety: prod applies no schema on deploy, so this code can
    // ship before the agent_connectors migration is applied. Fall back to the
    // metadata selection rather than failing every run on a missing relation.
    apiLogger.warn('resolveAgentConnectorKeys: falling back to metadata.integrations', {
      agentTaskId, error: error instanceof Error ? error.message : String(error),
    })
    return fromMetadata()
  }
}
