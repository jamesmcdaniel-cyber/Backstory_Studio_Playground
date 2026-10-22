import type { FlowGraph } from '@/lib/flows/graph'
import { matchBrandHint } from '@/lib/flows/tool-presentation'

/**
 * Post-import auth binding.
 *
 * An n8n export can never carry working credentials — n8n strips every secret
 * on export and leaves only `{id, name}` references that resolve solely inside
 * the source instance. So `n8nToFlow` (pure, DB-free) imports external calls
 * as unauthenticated http steps, and THIS pass — which runs in the import
 * route with the org's rows in hand — binds each one to auth the org already
 * has, so a flow whose providers are connected imports runnable instead of
 * red.
 *
 * Match order per http step (most precise wins):
 *   1. A verified HttpCredential whose allowedHost equals the URL host.
 *   2. A verified HttpCredential on a sibling host (same parent domain, e.g.
 *      `acme-x.snowflakecomputing.com` for the importer's
 *      `YOUR_ACCOUNT.snowflakecomputing.com` skeleton). The URL host is
 *      rewritten to the credential's host — the runtime enforces an exact
 *      host match, so binding without rewriting would only move the failure
 *      to run time.
 *   3. An active MCP connection whose name matches the URL's provider brand
 *      (mirrors the connected-integration probe in validate.ts), bound as a
 *      predefined connection.
 */

export type ImportMcpConnection = { id: string; name: string }
export type ImportHttpCredential = { id: string; name: string; allowedHost: string }

export type BindImportedAuthResult = {
  graph: FlowGraph
  /** One user-facing line per binding, phrased like the importer's warnings. */
  notes: string[]
  /** Labels of bound steps — used to drop their now-stale converter warnings. */
  boundLabels: string[]
}

const hostnameOf = (url: string): string | null => {
  if (url.includes('{{')) return null
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** `YOUR_ACCOUNT.snowflakecomputing.com` → `snowflakecomputing.com`; needs a real subdomain. */
const parentDomain = (host: string): string | null => {
  const labels = host.split('.')
  return labels.length >= 3 ? labels.slice(1).join('.') : null
}

const rewriteHost = (url: string, host: string): string => {
  const parsed = new URL(url)
  parsed.hostname = host
  return parsed.toString()
}

export function bindImportedHttpAuth(
  graph: FlowGraph,
  context: { mcpConnections: ImportMcpConnection[]; httpCredentials: ImportHttpCredential[] },
): BindImportedAuthResult {
  const notes: string[] = []
  const boundLabels: string[] = []
  const nodes = graph.nodes.map((node) => {
    if (node.type !== 'http' || node.data.credentialId || node.data.connectionId) return node
    const host = hostnameOf(node.data.url)
    if (!host) return node
    const label = node.data.label || 'HTTP step'

    const exact = context.httpCredentials.find((credential) => credential.allowedHost.toLowerCase() === host)
    if (exact) {
      notes.push(`“${label}”: authenticated with your “${exact.name}” credential (${exact.allowedHost}).`)
      boundLabels.push(label)
      return { ...node, data: { ...node.data, credentialId: exact.id } }
    }

    const parent = parentDomain(host)
    const sibling = parent
      ? context.httpCredentials.find((credential) => {
          const credentialHost = credential.allowedHost.toLowerCase()
          return credentialHost !== host && parentDomain(credentialHost) === parent
        })
      : undefined
    if (sibling) {
      const url = rewriteHost(node.data.url, sibling.allowedHost.toLowerCase())
      notes.push(
        `“${label}”: authenticated with your “${sibling.name}” credential — the request host is now ${sibling.allowedHost}.`,
      )
      boundLabels.push(label)
      return { ...node, data: { ...node.data, credentialId: sibling.id, url } }
    }

    const brand = matchBrandHint(host)
    if (brand && brand.key !== 'http') {
      const connection = context.mcpConnections.find((row) => matchBrandHint(row.name)?.key === brand.key)
      if (connection) {
        notes.push(`“${label}”: authenticated through your connected ${connection.name} integration.`)
        boundLabels.push(label)
        return { ...node, data: { ...node.data, connectionId: connection.id } }
      }
    }

    return node
  })
  return { graph: { ...graph, nodes }, notes, boundLabels }
}

/**
 * Agent HTTP endpoints materialized from n8n HTTP Request tools: bind each to
 * the verified credential for EXACTLY its host (an agent endpoint's URL is
 * the real API, never an importer placeholder, so no sibling rewrite).
 */
export function bindAgentEndpointAuth<T extends { name: string; url: string; credentialId?: string; connectionId?: string }>(
  endpoints: T[],
  httpCredentials: ImportHttpCredential[],
): { endpoints: T[]; notes: string[] } {
  const notes: string[] = []
  const bound = endpoints.map((endpoint) => {
    if (endpoint.credentialId || endpoint.connectionId) return endpoint
    // Endpoint URLs carry {{param}} placeholders in their PATH; only the host
    // must be literal to bind.
    const host = /^https?:\/\/([^/?#{}]+)(?:[/?#]|$)/i.exec(endpoint.url)?.[1]?.toLowerCase().replace(/:\d+$/, '') ?? null
    const credential = host ? httpCredentials.find((row) => row.allowedHost.toLowerCase() === host) : undefined
    if (!credential) return endpoint
    notes.push(`HTTP tool “${endpoint.name}”: authenticated with your “${credential.name}” credential (${credential.allowedHost}).`)
    return { ...endpoint, credentialId: credential.id }
  })
  return { endpoints: bound, notes }
}

const WAREHOUSE_SUFFIXES = {
  Snowflake: ['.snowflakecomputing.com'],
  Databricks: ['.cloud.databricks.com', '.azuredatabricks.net', '.gcp.databricks.com', '.databricks.us'],
} as const

/**
 * Warehouse steps find their credential by host at run time, so the
 * importer's "save a credential" note is stale once the workspace has one.
 * Drop those notes for each warehouse that already has a verified credential,
 * and say once which host its steps will use.
 */
export function resolveWarehouseCredentialNotes<N extends { code: string; message: string }>(
  notes: N[],
  httpCredentials: ImportHttpCredential[],
): { notes: N[]; satisfied: string[] } {
  const covered = new Map<string, string[]>()
  for (const label of Object.keys(WAREHOUSE_SUFFIXES) as Array<keyof typeof WAREHOUSE_SUFFIXES>) {
    const hosts = [...new Set(httpCredentials
      .map((row) => row.allowedHost.toLowerCase())
      .filter((host) => WAREHOUSE_SUFFIXES[label].some((suffix) => host.endsWith(suffix))))]
    if (hosts.length) covered.set(label, hosts)
  }
  const mentions = (label: string) => notes.some((note) => note.code === 'WAREHOUSE_CREDENTIAL' && note.message.includes(`its n8n ${label} credential`))
  const satisfied = [...covered]
    .filter(([label]) => mentions(label))
    .map(([label, hosts]) => hosts.length === 1
      ? `${label} steps run on your saved credential for ${hosts[0]}.`
      : `${label} steps need a "host" argument — this workspace has credentials for several ${label} hosts (${hosts.join(', ')}).`)
  const kept = notes.filter((note) => {
    if (note.code !== 'WAREHOUSE_CREDENTIAL') return true
    const label = /its n8n (Snowflake|Databricks) credential/.exec(note.message)?.[1]
    return !(label && covered.get(label)?.length === 1)
  })
  return { notes: kept, satisfied }
}

/** Converter warnings that told the user to wire up auth by hand — stale once bound. */
export function dropStaleAuthWarnings(warnings: string[], boundLabels: string[]): string[] {
  if (boundLabels.length === 0) return warnings
  const stale = (warning: string) =>
    boundLabels.some(
      (label) =>
        warning.startsWith(`“${label}”`) &&
        (warning.includes('credential does not transfer') || warning.includes('imported as a direct API request')),
    )
  return warnings.filter((warning) => !stale(warning))
}
