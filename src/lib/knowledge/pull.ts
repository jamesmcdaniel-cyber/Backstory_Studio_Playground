import { loadNangoPlaneGroups, loadNativePlaneGroups } from '@/features/agents/tool-planes'
import { parseFlowToolConnectionId } from '@/lib/flows/tool-connection-id'

export type RepositoryPullSource = {
  connectionId: string
  connectionName: string
  toolName: string
  description: string
  inputSchema: unknown
}

/**
 * Only actions with a deterministic read classification enter the repository
 * pull picker. Arbitrary MCP/People.ai tools are omitted because their schemas
 * do not currently carry a trusted readOnly hint.
 */
export async function loadRepositoryPullSources(organizationId: string, userId: string) {
  // Load only the two planes that carry trusted read classifications. Calling
  // the general flow catalog here would also discover every arbitrary MCP and
  // People.ai connection even though repository pulls intentionally omit them.
  const [native, nango] = await Promise.all([
    loadNativePlaneGroups(organizationId, { providers: ['granola'] }).catch(() => []),
    loadNangoPlaneGroups(organizationId, userId).catch(() => []),
  ])
  const sources: RepositoryPullSource[] = []
  for (const connection of [...native, ...nango]) {
    const parsed = parseFlowToolConnectionId(connection.id)
    const trustedRead = !connection.isWrite && (
      parsed.plane === 'nango' || (parsed.plane === 'native' && parsed.ref === 'granola')
    )
    if (!trustedRead) continue
    for (const tool of connection.tools) {
      sources.push({
        connectionId: connection.id,
        connectionName: connection.name,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })
    }
  }
  return sources.sort((a, b) =>
    a.connectionName.localeCompare(b.connectionName) || a.toolName.localeCompare(b.toolName),
  )
}

const SENSITIVE_KEY = /(authorization|cookie|password|secret|token|api[-_]?key|private[-_]?key)/i

/** Bounded, recursively redacted pull provenance safe to persist and display. */
export function redactPullArguments(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]'
  if (typeof value === 'string') return value.slice(0, 500)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redactPullArguments(entry, depth + 1))
  if (!value || typeof value !== 'object') return String(value ?? '')
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, entry]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactPullArguments(entry, depth + 1)]),
  )
}

export function pullResultText(result: unknown): { content: string; mimeType: string; truncated: boolean } {
  const raw = typeof result === 'string' ? result : JSON.stringify(result ?? null, null, 2)
  const limit = 200_000
  return {
    content: raw.slice(0, limit),
    mimeType: typeof result === 'string' ? 'text/plain' : 'application/json',
    truncated: raw.length > limit,
  }
}

/** Remove common credential shapes from provider errors before persistence. */
export function safePullError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 2_000)
}
