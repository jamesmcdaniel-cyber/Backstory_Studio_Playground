import { z } from 'zod'
import { McpCredentialError, mcpConfigFromConnection, type McpClientConfig } from '@/lib/mcp/mcp-client'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
import { apiLogger } from '@/lib/logger'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import { prisma } from '@/lib/prisma'
import { mergeAuthConfig } from '@/lib/crypto/secrets'
import { safeMcpVerificationError, verifyMcpConfig } from '@/lib/mcp/verify-connection'

// A draft may provide plaintext credentials. An existing connection may instead
// provide only connectionId; its encrypted credentials are resolved server-side.
const testSchema = z.object({
  connectionId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  serverUrl: z.string().url().optional(),
  authType: z.enum(['none', 'api_key', 'oauth2']).optional(),
  // api_key fields
  apiKey: z.string().optional(),
  headerName: z.string().optional(),
  // oauth2 fields
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  tokenUrl: z.string().optional(),
  scopes: z.string().optional(),
  flow: z.enum(['client_credentials']).optional(),
}).refine((data) => Boolean(data.connectionId || data.serverUrl), {
  message: 'serverUrl or connectionId is required',
})

export const POST = withAuthenticatedApi(async (request, auth) => {
  // Throttle: this endpoint makes server-side outbound requests to a
  // caller-supplied URL, so cap it to blunt scanning/abuse.
  const limited = await rateLimit(`mcp-test:${auth.dbUser.id}`, { limit: 10, windowMs: 60_000 })
  if (!limited.ok) throw new ApiError('Too many connection tests — slow down.', 429, 'RATE_LIMITED')

  const data = testSchema.parse(await request.json().catch(() => ({})))
  const existing = data.connectionId
    ? await prisma.mcpConnection.findFirst({
        where: {
          id: data.connectionId,
          organizationId: auth.organizationId,
          OR: [{ userId: null }, { userId: auth.dbUser.id }],
        },
      })
    : null
  if (data.connectionId && !existing) {
    throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')
  }

  const serverUrl = data.serverUrl ?? existing?.serverUrl
  if (!serverUrl) throw new ApiError('Server URL is required', 400, 'INVALID_REQUEST')
  const authType = data.authType ?? existing?.authType ?? 'none'

  // SSRF guard: reject internal/private/metadata targets before connecting.
  // Both serverUrl AND the oauth2 tokenUrl are fetched server-side, so guard both.
  try {
    await assertPublicUrl(serverUrl)
    if (data.tokenUrl) await assertPublicUrl(data.tokenUrl)
  } catch (error) {
    if (error instanceof SsrfError) return { ok: false, error: 'That server or token URL is not allowed.' }
    throw error
  }

  // Everything from here on is INSIDE the try, credential decryption included.
  // Building the config outside it meant the one failure this endpoint exists
  // to explain — a stored secret that cannot be read — was the one failure it
  // could not report: mcpConfigFromConnection threw past the handler and the
  // caller got a bare 500 instead of "reconnect it".
  try {
    let config: McpClientConfig
    if (existing) {
      const stored =
        existing.authConfig && typeof existing.authConfig === 'object' && !Array.isArray(existing.authConfig)
          ? (existing.authConfig as Record<string, unknown>)
          : {}
      const merged = mergeAuthConfig(stored, {
        authType: authType as 'none' | 'api_key' | 'oauth2',
        apiKey: data.apiKey,
        headerName: data.headerName,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        tokenUrl: data.tokenUrl,
        scopes: data.scopes,
        flow: data.flow,
      })
      config = mcpConfigFromConnection({ serverUrl, authType, authConfig: merged })
    } else {
      config = {
        serverUrl,
        authType: authType as 'none' | 'api_key' | 'oauth2',
        apiKey: data.apiKey,
        headerName: data.headerName,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        tokenUrl: data.tokenUrl,
        scopes: data.scopes,
      }
    }

    const verification = await verifyMcpConfig(config)
    if (existing) {
      await prisma.mcpConnection.update({
        where: { id: existing.id, organizationId: auth.organizationId },
        data: { lastVerifiedAt: verification.verifiedAt, healthStatus: 'healthy', lastError: null, toolSchemaHash: verification.schemaHash },
      })
    }
    return {
      ok: true,
      verifiedAt: verification.verifiedAt,
      toolCount: verification.toolCount,
      toolNames: verification.toolNames,
    }
  } catch (error) {
    // The user-facing message names the fix; the storage-format detail behind
    // it is only useful to whoever holds the key ring, so it goes to the log.
    if (error instanceof McpCredentialError) {
      apiLogger.warn('MCP connection test: stored credential could not be decrypted', {
        connectionId: existing?.id,
        organizationId: auth.organizationId,
        field: error.field,
        cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
      })
    }
    if (existing) {
      await prisma.mcpConnection.update({
        where: { id: existing.id, organizationId: auth.organizationId },
        data: { lastVerifiedAt: new Date(), healthStatus: 'unhealthy', lastError: safeMcpVerificationError(error) },
      }).catch(() => undefined)
    }
    return { ok: false, error: safeMcpVerificationError(error) }
  }
}, { permission: 'integration.manage' })
