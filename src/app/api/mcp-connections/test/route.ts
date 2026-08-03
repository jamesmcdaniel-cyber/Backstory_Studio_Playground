import { z } from 'zod'
import { mcpConfigFromConnection, type McpClientConfig } from '@/lib/mcp/mcp-client'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { rateLimit } from '@/lib/ratelimit'
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

  try {
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
    if (existing) {
      await prisma.mcpConnection.update({
        where: { id: existing.id, organizationId: auth.organizationId },
        data: { lastVerifiedAt: new Date(), healthStatus: 'unhealthy', lastError: safeMcpVerificationError(error) },
      }).catch(() => undefined)
    }
    return { ok: false, error: safeMcpVerificationError(error) }
  }
}, { permission: 'integration.manage' })
