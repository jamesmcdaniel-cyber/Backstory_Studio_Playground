import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'
import type { FlowGraph, FlowNode } from '@/lib/flows/graph'

/**
 * What stops working if a credential goes away.
 *
 * The audit trail answers "who used this credential" — after the fact. Nobody
 * could answer it BEFORE: revoking a connection, rotating a key or deactivating
 * the colleague who owned one was a change whose blast radius was discovered by
 * something breaking on a schedule at 6am. n8n keeps a credential index for
 * exactly this; ours is the same idea over our own reference shapes.
 *
 * The graph scan is pure and lives here so it can be tested against real graph
 * shapes without a database, and reused by the revoke path, the credentials
 * page and any future report.
 */

export type CredentialRef =
  /** An MCP connection, by row id — bound as `mcp:<id>` inside a graph. */
  | { kind: 'mcp_connection'; id: string }
  /** A reusable HTTP credential, by row id. */
  | { kind: 'http_credential'; id: string }
  /** A Nango connected account, by the connector key a graph names it with. */
  | { kind: 'nango'; connectorKey: string }

/** Every credential a single step names. */
export function nodeCredentialRefs(node: FlowNode): CredentialRef[] {
  const data = node.data as { connectionId?: unknown; credentialId?: unknown }
  const refs: CredentialRef[] = []

  if (typeof data.credentialId === 'string' && data.credentialId.trim()) {
    refs.push({ kind: 'http_credential', id: data.credentialId.trim() })
  }

  if (typeof data.connectionId === 'string' && data.connectionId.trim()) {
    // A graph stores a plane-qualified id (`mcp:abc`, `nango:slack_post`).
    // Which plane it names decides which credential it is.
    const { plane, ref } = parseFlowToolConnectionId(data.connectionId.trim())
    if (plane === 'mcp') refs.push({ kind: 'mcp_connection', id: ref })
    else if (plane === 'nango') refs.push({ kind: 'nango', connectorKey: ref })
  }

  return refs
}

/**
 * Every credential a graph names, deduplicated.
 *
 * One flat pass is enough, and is the CORRECT reading: a container step holds
 * its children as node IDS (`loop.body`, `parallel.branches`) while the steps
 * themselves live in `graph.nodes` alongside everything else. A Slack call
 * inside a For-each is exactly as broken by a revoked connection as one at the
 * top level, and it is already in this list.
 */
export function graphCredentialRefs(graph: Pick<FlowGraph, 'nodes'>): CredentialRef[] {
  const seen = new Map<string, CredentialRef>()
  for (const node of graph.nodes ?? []) {
    for (const ref of nodeCredentialRefs(node)) {
      seen.set(credentialRefKey(ref), ref)
    }
  }
  return [...seen.values()]
}

/** A stable key for comparing two references. */
export function credentialRefKey(ref: CredentialRef): string {
  return ref.kind === 'nango' ? `nango:${ref.connectorKey}` : `${ref.kind}:${ref.id}`
}

export function sameCredential(a: CredentialRef, b: CredentialRef): boolean {
  return credentialRefKey(a) === credentialRefKey(b)
}

/** Does this graph depend on the given credential? */
export function graphDependsOn(graph: Pick<FlowGraph, 'nodes'>, ref: CredentialRef): boolean {
  return graphCredentialRefs(graph).some((found) => sameCredential(found, ref))
}

export type CredentialDependent =
  | { type: 'flow'; id: string; name: string; published: boolean }
  | { type: 'agent'; id: string; name: string }

/**
 * Order the answer by what hurts.
 *
 * A published flow is live — it runs on a schedule or a trigger with nobody
 * watching — so it leads. A draft breaks only for whoever next opens it.
 */
export function rankDependents(dependents: readonly CredentialDependent[]): CredentialDependent[] {
  const weight = (entry: CredentialDependent) => (entry.type === 'flow' && entry.published ? 0 : entry.type === 'flow' ? 2 : 1)
  return [...dependents].sort((a, b) => weight(a) - weight(b) || a.name.localeCompare(b.name))
}

/**
 * One sentence an operator reads before revoking.
 *
 * Says the live count first and separately, because "3 things use this" and
 * "one of them is published and runs hourly" are different decisions.
 */
export function describeDependents(dependents: readonly CredentialDependent[]): string {
  if (dependents.length === 0) return 'Nothing uses this credential.'
  const publishedFlows = dependents.filter((entry) => entry.type === 'flow' && entry.published).length
  const draftFlows = dependents.filter((entry) => entry.type === 'flow' && !entry.published).length
  const agents = dependents.filter((entry) => entry.type === 'agent').length

  const parts: string[] = []
  if (publishedFlows) parts.push(`${publishedFlows} published flow${publishedFlows === 1 ? '' : 's'}`)
  if (draftFlows) parts.push(`${draftFlows} draft flow${draftFlows === 1 ? '' : 's'}`)
  if (agents) parts.push(`${agents} agent${agents === 1 ? '' : 's'}`)

  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]
  return publishedFlows > 0
    ? `Revoking this stops ${list} — the published ones run without anyone watching.`
    : `${list.charAt(0).toUpperCase()}${list.slice(1)} use this credential.`
}
