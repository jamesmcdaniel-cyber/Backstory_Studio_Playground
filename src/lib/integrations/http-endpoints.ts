/**
 * Configured API endpoints on an agent — the agent-side equivalent of the flow
 * HTTP step. Each endpoint (method, URL, query, headers, body, auth binding)
 * is saved on the agent (metadata.httpEndpoints) and surfaces at run time as
 * its own callable tool, so the model invokes "get_weather(city)" instead of
 * composing raw requests.
 *
 * `{{param}}` placeholders anywhere in the URL, query values, header values,
 * or body become the tool's typed arguments: the model supplies them, the
 * runtime substitutes them (URL-encoded where they land in the URL/query).
 * Auth never rides in the config: `credentialId` points at an encrypted,
 * host-locked workspace credential; `connectionId` at a connected integration
 * whose fresh token is injected server-side at call time.
 */

import { z } from 'zod'

export const AGENT_HTTP_ENDPOINT_LIMIT = 20

export const agentHttpEndpointSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
  url: z.string().min(1).max(2000),
  /** Query parameters appended to the URL. Values may hold {{param}} placeholders. */
  query: z.record(z.string(), z.string()).optional(),
  /** Request headers. Values may hold {{param}} placeholders — never secrets. */
  headers: z.record(z.string(), z.string()).optional(),
  bodyMode: z.enum(['none', 'json']).optional(),
  body: z.string().max(20_000).optional(),
  /** Generic reusable credential (encrypted, host-locked HttpCredential id). */
  credentialId: z.string().optional(),
  /** Predefined integration: an org MCP connection id whose token is injected. */
  connectionId: z.string().optional(),
})
export type AgentHttpEndpoint = z.infer<typeof agentHttpEndpointSchema>

/** Read endpoints from an agent's metadata grab-bag, dropping malformed rows. */
export function parseAgentHttpEndpoints(value: unknown): AgentHttpEndpoint[] {
  if (!Array.isArray(value)) return []
  const endpoints: AgentHttpEndpoint[] = []
  for (const entry of value.slice(0, AGENT_HTTP_ENDPOINT_LIMIT)) {
    const parsed = agentHttpEndpointSchema.safeParse(entry)
    if (parsed.success) endpoints.push(parsed.data)
  }
  return endpoints
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g

/** The {{param}} names an endpoint expects, in first-appearance order. */
export function endpointParams(endpoint: AgentHttpEndpoint): string[] {
  const seen = new Set<string>()
  const scan = (text: string | undefined) => {
    if (!text) return
    for (const match of text.matchAll(PLACEHOLDER)) seen.add(match[1])
  }
  scan(endpoint.url)
  for (const value of Object.values(endpoint.query ?? {})) scan(value)
  for (const value of Object.values(endpoint.headers ?? {})) scan(value)
  scan(endpoint.body)
  return Array.from(seen)
}

/** Substitute {{param}} values; `encode` for parts that land in the URL. */
export function fillEndpointTemplate(text: string, args: Record<string, unknown>, opts?: { encode?: boolean }): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    const value = args[name]
    const raw = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
    return opts?.encode ? encodeURIComponent(raw) : raw
  })
}

/** Tool name for an endpoint: "Get weather" → "get_weather" (model-friendly). */
export function endpointToolName(endpoint: AgentHttpEndpoint): string {
  const slug = endpoint.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return slug || `endpoint_${endpoint.id.slice(0, 8)}`
}

/** The JSON-schema tool definition an endpoint exposes to the model. */
export function endpointToolDefinition(endpoint: AgentHttpEndpoint): {
  name: string
  description: string
  inputSchema: Record<string, unknown>
} {
  const params = endpointParams(endpoint)
  return {
    name: endpointToolName(endpoint),
    description:
      `${endpoint.description?.trim() || endpoint.name} — calls ${endpoint.method} ${endpoint.url.replace(PLACEHOLDER, (_m, p: string) => `<${p}>`)}. ` +
      'A configured API endpoint on this agent; authentication is attached automatically.',
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(params.map((param) => [param, { type: 'string', description: `Value for ${param}.` }])),
      required: params,
    },
  }
}
