import { sameServerUrl } from '@/lib/mcp/server-url'

/**
 * An HTTP step that is really an MCP call, and the Tool step it should be.
 *
 * Calling an MCP server by hand means a POST to its endpoint carrying a
 * JSON-RPC envelope — `{"method":"tools/call","params":{"name":"top_records"}}`
 * — with the tool name buried in a body field and the arguments hand-written as
 * JSON. The Tool step does the same call as three controls: connection, action,
 * arguments, with the action picked from a list and the arguments rendered from
 * the tool's own schema.
 *
 * People end up on the HTTP step anyway — an import that predates the mapping,
 * or a moment when the connection was unhealthy and offered no tools. Detecting
 * it costs nothing and the panel can offer the swap rather than leaving someone
 * maintaining a hand-built JSON-RPC envelope.
 *
 * Pure: the panel decides what to show, this decides whether there is anything
 * to show.
 */

export type McpConnectionLike = { id: string; name: string; serverUrl?: string }

export type McpStepSuggestion = {
  connectionId: string
  connectionName: string
  /** The tool the JSON-RPC body names, when it names one. */
  toolName?: string
  /** The `arguments` object the body carries, as a JSON string. */
  args?: string
}

/** Does this URL look like an MCP endpoint at all? */
export function isMcpEndpointUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!trimmed || trimmed.includes('{{')) return false
  try {
    const parsed = new URL(trimmed)
    // The convention every server we integrate with follows, and the one the
    // spec's examples use. Deliberately narrow: guessing wrong would put a
    // "convert me" banner on an ordinary API call.
    return /(^|\/)mcp\/?$/.test(parsed.pathname) || /^mcp\./.test(parsed.hostname)
  } catch {
    return false
  }
}

/**
 * Read the tool name and arguments out of a JSON-RPC body.
 *
 * Tolerant of a templated body — a `{{token}}` anywhere makes it unparseable as
 * JSON, and in that case the swap is still offered without a pre-filled action
 * rather than not offered at all.
 */
export function readJsonRpcCall(body: unknown): { toolName?: string; args?: string } {
  if (typeof body !== 'string' || !body.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const envelope = parsed as { method?: unknown; params?: unknown }
  if (envelope.method !== 'tools/call') return {}
  const params = envelope.params
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {}
  const { name, arguments: args } = params as { name?: unknown; arguments?: unknown }
  // A templated name is valid JSON and unusable as a pre-fill: you cannot pick
  // `{{steps.pick.tool}}` from a list of the connection's actions. The swap is
  // still worth offering; the action is just left for the user to choose.
  const literalName = typeof name === 'string' && name.trim() && !name.includes('{{') ? name.trim() : null
  return {
    ...(literalName ? { toolName: literalName } : {}),
    ...(args && typeof args === 'object' ? { args: JSON.stringify(args, null, 2) } : {}),
  }
}

/**
 * The Tool step this HTTP step should be, or null.
 *
 * Requires a CONNECTED server matching the URL: offering to convert to a
 * connection the workspace does not have would swap a step that works for one
 * that cannot run.
 */
export function mcpStepSuggestion(
  node: { type: string; data: Record<string, unknown> },
  connections: readonly McpConnectionLike[],
): McpStepSuggestion | null {
  if (node.type !== 'http') return null
  const url = typeof node.data.url === 'string' ? node.data.url : ''
  if (!isMcpEndpointUrl(url)) return null

  const match = connections.find((connection) => connection.serverUrl && sameServerUrl(connection.serverUrl, url))
  if (!match) return null

  return {
    connectionId: match.id,
    connectionName: match.name,
    ...readJsonRpcCall(node.data.body),
  }
}
