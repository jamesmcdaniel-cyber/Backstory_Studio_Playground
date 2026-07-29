/**
 * Best-effort OAuth discovery for the "Add MCP server" dialog.
 *
 * POST /api/mcp-connections/discover  { serverUrl }
 *
 * Fetches the target server's `.well-known/oauth-authorization-server`
 * document (same discovery mechanism McpClient's client-credentials flow
 * already relies on) and reports whether it advertises an authorization
 * endpoint. The dialog uses this to stop defaulting silently to "None" auth
 * for servers that require OAuth — inconclusive results (network error,
 * timeout, no discovery document) resolve to `requiresOAuth: false` so a
 * server we simply couldn't probe never blocks or misleads the user.
 */

import { z } from 'zod'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'

const discoverSchema = z.object({
  serverUrl: z.string().url(),
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  // This makes a server-side outbound request to a caller-supplied URL —
  // throttle it the same as the connection test endpoint.
  const limited = await rateLimit(`mcp-discover:${auth.dbUser.id}`, { limit: 20, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many discovery checks — slow down.', 429, 'RATE_LIMITED')

  const { serverUrl } = discoverSchema.parse(await request.json().catch(() => ({})))

  let discoveryUrl: string
  try {
    discoveryUrl = `${new URL(serverUrl).origin}/.well-known/oauth-authorization-server`
  } catch {
    return { requiresOAuth: false }
  }

  try {
    await assertPublicUrl(discoveryUrl)
  } catch (error) {
    if (error instanceof SsrfError) return { requiresOAuth: false }
    throw error
  }

  try {
    const response = await fetch(discoveryUrl, {
      redirect: 'error', // don't let a 3xx bounce us to an internal host
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return { requiresOAuth: false }

    const meta = (await response.json().catch(() => null)) as { authorization_endpoint?: string } | null
    if (meta?.authorization_endpoint) {
      return { requiresOAuth: true }
    }
    return { requiresOAuth: false }
  } catch {
    // Network error, timeout, or non-JSON body — inconclusive, not a "no".
    return { requiresOAuth: false }
  }
}, { permission: 'integration.manage' })
