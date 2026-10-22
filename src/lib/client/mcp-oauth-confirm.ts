'use client'

import { newConnectionLanded, reconnectLanded, type ListedConnection } from '@/lib/mcp/reconnect'

/**
 * Server-side confirmation for MCP sign-ins run in the embedded popup — the
 * `check` half of useEmbeddedOAuth. Each reads the connections list the
 * surfaces already load, so no route exists only to be polled.
 */

async function listConnections(): Promise<ListedConnection[] | null> {
  try {
    const response = await fetch('/api/mcp-connections', { cache: 'no-store' })
    if (!response.ok) return null
    const data = (await response.json()) as { connections?: ListedConnection[] }
    return data.connections ?? []
  } catch {
    return null
  }
}

/** True once the connection has been re-verified since `lastVerifiedAt`. */
export function mcpReconnectCheck(connection: { id: string; lastVerifiedAt: string | null }): () => Promise<boolean> {
  const before = { lastVerifiedAt: connection.lastVerifiedAt }
  return async () => {
    const rows = await listConnections()
    return reconnectLanded(before, rows?.find((row) => row.id === connection.id))
  }
}

/**
 * True once a server with this name and URL exists that did not when the flow
 * started. The baseline is read right after the popup opens — never before, as
 * an awaited fetch would cost the click its popup permission — and the sign-in
 * on the other side takes far longer than that read.
 */
export function mcpNewConnectionCheck(wanted: { name: string; serverUrl: string }): () => Promise<boolean> {
  const baseline = listConnections().then((rows) => (rows ? new Set(rows.map((row) => row.id)) : null))
  return async () => {
    const existing = await baseline
    if (!existing) return false
    const rows = await listConnections()
    return rows ? newConnectionLanded(wanted, existing, rows) : false
  }
}
