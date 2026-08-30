import { flowGraphSchema, type FlowGraph } from '@/lib/flows/graph'
import type { FlowTemplateBinding, FlowTemplateNotes } from '@/lib/flows/templates/types'

/**
 * Resolving a template's empty graph slots against a real workspace.
 *
 * A template ships `agentId` / `connectionId` as '' plus a binding that says
 * what belongs there. Everything in this module is PURE over the roster and
 * tool catalog it's handed — the DB reads live in `instantiate.ts` — so the
 * matching rules are directly testable.
 */

export type BindingAgent = { id: string; name: string }
export type BindingConnection = { id: string; name: string; tools: { name: string }[] }
export type BindingContext = { agents: BindingAgent[]; connections: BindingConnection[] }

export type BindingResolution = {
  binding: FlowTemplateBinding
  /** The workspace id to write into the node, or null when nothing matched. */
  resolvedId: string | null
}

const norm = (value: string): string => value.trim().toLowerCase()

/** Exact (case-insensitive) name first, then a containment match either way. */
function matchAgent(agents: BindingAgent[], wanted: string | undefined): BindingAgent | null {
  if (!wanted?.trim()) return null
  const target = norm(wanted)
  return (
    agents.find((agent) => norm(agent.name) === target) ??
    agents.find((agent) => norm(agent.name).includes(target) || target.includes(norm(agent.name))) ??
    null
  )
}

/**
 * Connection ids are plane-prefixed ('nango:salesforce', 'native:slack',
 * 'people_ai:backstory') except MCP rows, which keep a raw database id — so a
 * provider hint matches on id first, then on the connection's display name.
 * A `toolName` hint narrows to a connection that actually exposes it.
 */
function matchConnection(
  connections: BindingConnection[],
  provider: string | undefined,
  toolName: string | undefined,
): BindingConnection | null {
  if (!provider?.trim()) return null
  const target = norm(provider)
  // Drop the plane prefix so a 'salesforce' hint still matches 'nango:salesforce'.
  const bare = target.includes(':') ? target.slice(target.indexOf(':') + 1) : target
  const hasTool = (connection: BindingConnection) =>
    !toolName?.trim() || connection.tools.some((tool) => norm(tool.name) === norm(toolName))

  const candidates = connections.filter(hasTool)
  return (
    candidates.find((connection) => norm(connection.id) === target) ??
    candidates.find((connection) => norm(connection.id).endsWith(`:${bare}`)) ??
    candidates.find((connection) => norm(connection.name) === bare) ??
    candidates.find((connection) => norm(connection.name).includes(bare)) ??
    null
  )
}

export function resolveBindings(bindings: FlowTemplateBinding[], context: BindingContext): BindingResolution[] {
  return bindings.map((binding) => ({
    binding,
    resolvedId:
      binding.kind === 'agent'
        ? (matchAgent(context.agents, binding.match.agentName)?.id ?? null)
        : (matchConnection(context.connections, binding.match.provider, binding.match.toolName)?.id ?? null),
  }))
}

/**
 * Write every resolved id into its node. Unresolved slots are left empty on
 * purpose: the validator flags them, and they become setup items — the flow
 * still lands so the user can see the whole pipeline.
 */
export function applyBindings(graph: FlowGraph, resolutions: BindingResolution[]): FlowGraph {
  const byNode = new Map(resolutions.filter((entry) => entry.resolvedId).map((entry) => [entry.binding.nodeId, entry]))
  if (byNode.size === 0) return graph
  const next = {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const entry = byNode.get(node.id)
      if (!entry?.resolvedId) return node
      if (node.type === 'agent' && entry.binding.kind === 'agent') {
        return { ...node, data: { ...node.data, agentId: entry.resolvedId } }
      }
      if ((node.type === 'tool' || node.type === 'http') && entry.binding.kind === 'connection') {
        return { ...node, data: { ...node.data, connectionId: entry.resolvedId } }
      }
      // A polling trigger names the app it checks; the connection lives inside
      // the trigger config rather than on the node's own data.
      if (node.type === 'trigger' && entry.binding.kind === 'connection') {
        const trigger = node.data.trigger && typeof node.data.trigger === 'object' ? node.data.trigger : {}
        return { ...node, data: { ...node.data, trigger: { ...trigger, connectionId: entry.resolvedId } } }
      }
      return node
    }),
  }
  return flowGraphSchema.parse(next)
}

/** One thing the user must do before this flow can run. */
export type FlowTemplateSetupItem = {
  kind: 'integration' | 'agent' | 'value'
  label: string
  /** The step to focus in the builder, when the item is about one step. */
  nodeId?: string
  /** Provider key, so the UI can deep-link to connecting it. */
  provider?: string
}

/**
 * The "Finish setup" checklist: unresolved bindings first (they block the
 * flow), then the template's own declared steps, then referenced-but-not-
 * connected integrations. Deduped by label, order preserved.
 */
export function buildSetupChecklist(
  resolutions: BindingResolution[],
  notes: FlowTemplateNotes | null,
  missingIntegrations: string[] = [],
): FlowTemplateSetupItem[] {
  const items: FlowTemplateSetupItem[] = []
  for (const { binding, resolvedId } of resolutions) {
    if (resolvedId) continue
    items.push({
      kind: binding.kind === 'agent' ? 'agent' : 'integration',
      label: binding.label,
      nodeId: binding.nodeId,
      ...(binding.match.provider ? { provider: binding.match.provider } : {}),
    })
  }
  for (const step of notes?.setup ?? []) {
    // Integration checklist entries describe prerequisites, not permanent
    // chores. Once the provider is connected, do not keep telling the user to
    // connect it. Likewise, a declared agent slot disappears after its binding
    // resolved (including dependencies provisioned during import).
    if (step.kind === 'integration' && step.ref) {
      const wanted = norm(step.ref).replace(/^nango:/, '').replace(/^native:/, '')
      const missing = missingIntegrations.some((provider) => {
        const candidate = norm(provider).replace(/^nango:/, '').replace(/^native:/, '')
        return candidate === wanted
      })
      if (!missing) continue
    }
    if (step.kind === 'agent' && step.ref) {
      const binding = resolutions.find((entry) => entry.binding.nodeId === step.ref && entry.binding.kind === 'agent')
      if (binding?.resolvedId) continue
    }
    items.push({ kind: step.kind, label: step.label, ...(step.kind === 'integration' && step.ref ? { provider: step.ref } : {}) })
  }
  for (const provider of missingIntegrations) {
    items.push({ kind: 'integration', label: `Connect ${provider}`, provider })
  }
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.label.trim().toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
