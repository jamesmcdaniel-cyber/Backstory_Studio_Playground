/**
 * Per-tool permissions on an MCP connection.
 *
 * Set from the server's detail view in Integrations, the way Claude's connector
 * page does it: every tool is Always allow, Needs approval or Blocked.
 *
 * Stored on McpConnection.toolPolicies as a sparse map — only 'approve' and
 * 'off' are written, and a tool that is absent is ALLOWED. That default is the
 * point: a tool the server adds tomorrow is usable without anyone revisiting
 * the page, exactly as on Claude, and a row nobody has touched stays `{}`.
 *
 * Pure (no server imports) so the browser and the runtime read the same rules.
 */

export type McpToolPolicy = 'allow' | 'approve' | 'off'
export type StoredMcpToolPolicies = Record<string, Exclude<McpToolPolicy, 'allow'>>

export const MCP_TOOL_POLICIES: readonly McpToolPolicy[] = ['allow', 'approve', 'off']

/** Read the stored JSON defensively: anything that is not a known value is "allowed". */
export function readToolPolicies(raw: unknown): StoredMcpToolPolicies {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: StoredMcpToolPolicies = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === 'approve' || value === 'off') out[name] = value
  }
  return out
}

export function toolPolicyFor(policies: StoredMcpToolPolicies, toolName: string): McpToolPolicy {
  return Object.prototype.hasOwnProperty.call(policies, toolName) ? policies[toolName] : 'allow'
}

/** Apply a change set. 'allow' removes the entry rather than storing the default. */
export function mergeToolPolicies(
  existing: StoredMcpToolPolicies,
  changes: Record<string, McpToolPolicy>,
): StoredMcpToolPolicies {
  const next: StoredMcpToolPolicies = { ...existing }
  for (const [name, policy] of Object.entries(changes)) {
    if (policy === 'allow') delete next[name]
    else next[name] = policy
  }
  return next
}

/**
 * The tool's name as a person reads it: `account_company_news` → "Account
 * company news", `getOpportunityStatus` → "Get opportunity status".
 */
export function humanizeToolName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.\s]+/g, ' ')
    .trim()
    .toLowerCase()
  if (!spaced) return name
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** What a run, a flow step or an approval is told when it reaches a blocked tool. */
export function blockedToolMessage(toolName: string, serverName: string): string {
  return `${toolName} is turned off for ${serverName} in Integrations`
}

/** What an unattended caller is told when it reaches a tool that needs a person's approval. */
export function approvalUnavailableMessage(toolName: string, serverName: string): string {
  return `${toolName} needs approval before it runs on ${serverName}, and this run cannot pause to ask — set it to Always allow in Integrations to use it here`
}

/** Thrown when a blocked tool is resolved for execution. Callers may match on it. */
export class McpToolBlockedError extends Error {
  constructor(toolName: string, serverName: string) {
    super(blockedToolMessage(toolName, serverName))
    this.name = 'McpToolBlockedError'
  }
}

/** MCP tool annotations (2025-03-26 spec) — hints only, as servers self-report them. */
export type McpToolAnnotations = {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/** Keep only the annotation fields we understand, with the types the spec gives them. */
export function readToolAnnotations(raw: unknown): McpToolAnnotations | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const source = raw as Record<string, unknown>
  const out: McpToolAnnotations = {}
  if (typeof source.title === 'string' && source.title.trim()) out.title = source.title.trim().slice(0, 120)
  for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
    if (typeof source[key] === 'boolean') out[key] = source[key] as boolean
  }
  return Object.keys(out).length ? out : undefined
}
