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
