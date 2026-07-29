import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import {
  buildAuthConfig,
  mergeAuthConfig,
  redactConfig,
} from '@/lib/crypto/secrets'
import { assertPublicUrl, SsrfError } from '@/lib/net/ssrf'
import { cacheDelete } from '@/lib/cache'
import { safeMcpVerificationError, verifyStoredMcpConnection } from '@/lib/mcp/verify-connection'

// Mirror of execute-agent's toolDiscoveryCacheKey (org-scoped) — kept in sync
// deliberately; busting it makes a connection edit take effect before the TTL.
const toolDiscoveryCacheKey = (organizationId: string, serverUrl: string) => `mcptools:${organizationId}:${serverUrl}`

/** SSRF guard for a user-supplied URL field; rejects private/internal targets. */
async function requirePublicUrl(url: string | undefined, field: string): Promise<void> {
  if (!url) return
  try {
    await assertPublicUrl(url)
  } catch (error) {
    if (error instanceof SsrfError) throw new ApiError(`${field} is not allowed: ${error.message}`, 400, 'INVALID_URL')
    throw error
  }
}

// ── Zod schema ───────────────────────────────────────────────────────────

const mcpConnectionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  serverUrl: z.string().url(),
  authType: z.enum(['none', 'api_key', 'oauth2']).default('none'),
  // api_key fields
  apiKey: z.string().optional(),
  headerName: z.string().optional(),
  // oauth2 fields
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  tokenUrl: z.string().optional(),
  scopes: z.string().optional(),
  // common
  isActive: z.boolean().optional(),
})

// ── Serialiser (redacts secrets) ─────────────────────────────────────────

function serializeConnection(conn: {
  id: string
  organizationId: string
  provider: string | null
  userId: string | null
  name: string
  description: string | null
  serverUrl: string
  authType: string
  authConfig: unknown
  isActive: boolean
  lastVerifiedAt: Date | null
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: conn.id,
    organizationId: conn.organizationId,
    provider: conn.provider,
    userId: conn.userId,
    name: conn.name,
    description: conn.description,
    serverUrl: conn.serverUrl,
    isActive: conn.isActive,
    lastVerifiedAt: conn.lastVerifiedAt,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
    auth: redactConfig(conn.authType, conn.authConfig),
  }
}

// ── GET — list org's connections ─────────────────────────────────────────

export const GET = withAuthenticatedApi(async (_request, auth) => {
  const connections = await prisma.mcpConnection.findMany({
    where: { organizationId: auth.organizationId, OR: [{ userId: null }, { userId: auth.dbUser.id }] },
    orderBy: { createdAt: 'desc' },
  })

  return {
    success: true,
    connections: connections.map(serializeConnection),
  }
}, { permission: 'flow.read' })

// ── POST — create a connection ────────────────────────────────────────────

export const POST = withAuthenticatedApi(async (request, auth) => {
  const data = mcpConnectionSchema.parse(await request.json())
  await requirePublicUrl(data.serverUrl, 'serverUrl')
  await requirePublicUrl(data.tokenUrl, 'tokenUrl')

  const authConfig = buildAuthConfig({
    authType: data.authType,
    apiKey: data.apiKey,
    headerName: data.headerName,
    clientId: data.clientId,
    clientSecret: data.clientSecret,
    tokenUrl: data.tokenUrl,
    scopes: data.scopes,
  })

  let verification
  try {
    verification = await verifyStoredMcpConnection({
      serverUrl: data.serverUrl,
      authType: data.authType,
      authConfig,
    })
  } catch (error) {
    throw new ApiError(
      `Connection could not be verified: ${safeMcpVerificationError(error)}`,
      422,
      'CONNECTION_VERIFICATION_FAILED',
    )
  }

  const connection = await prisma.mcpConnection.create({
    data: {
      organizationId: auth.organizationId,
      name: data.name,
      description: data.description ?? null,
      serverUrl: data.serverUrl,
      authType: data.authType,
      authConfig: authConfig as Prisma.InputJsonValue,
      isActive: data.isActive ?? true,
      lastVerifiedAt: verification.verifiedAt,
    },
  })

  return {
    success: true,
    connection: serializeConnection(connection),
    verification: { toolCount: verification.toolCount, toolNames: verification.toolNames },
  }
}, { permission: 'integration.manage' })

// ── PUT — update a connection ─────────────────────────────────────────────

export const PUT = withAuthenticatedApi(async (request, auth) => {
  const body = z
    .object({ id: z.string().min(1) })
    .merge(mcpConnectionSchema.partial())
    .parse(await request.json())

  const existing = await prisma.mcpConnection.findFirst({
    where: { id: body.id, organizationId: auth.organizationId },
  })
  if (!existing) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')
  if (existing.provider) {
    throw new ApiError('This connection is managed by the platform and cannot be edited or deleted.', 403, 'PROVIDER_MANAGED')
  }

  await requirePublicUrl(body.serverUrl, 'serverUrl')
  await requirePublicUrl(body.tokenUrl, 'tokenUrl')

  // Merge authConfig: preserve secrets not provided in this update
  const existingConfig =
    existing.authConfig &&
    typeof existing.authConfig === 'object' &&
    !Array.isArray(existing.authConfig)
      ? (existing.authConfig as Record<string, unknown>)
      : {}

  const newAuthType = body.authType ?? existing.authType
  const authConfig = mergeAuthConfig(existingConfig, {
    authType: newAuthType as 'none' | 'api_key' | 'oauth2',
    apiKey: body.apiKey,
    headerName: body.headerName,
    clientId: body.clientId,
    clientSecret: body.clientSecret,
    tokenUrl: body.tokenUrl,
    scopes: body.scopes,
  })

  const connectionFieldsChanged =
    body.serverUrl !== undefined ||
    body.authType !== undefined ||
    body.apiKey !== undefined ||
    body.headerName !== undefined ||
    body.clientId !== undefined ||
    body.clientSecret !== undefined ||
    body.tokenUrl !== undefined ||
    body.scopes !== undefined ||
    body.isActive === true
  let verifiedAt: Date | undefined
  if (connectionFieldsChanged) {
    try {
      const verification = await verifyStoredMcpConnection({
        serverUrl: body.serverUrl ?? existing.serverUrl,
        authType: newAuthType,
        authConfig,
      })
      verifiedAt = verification.verifiedAt
    } catch (error) {
      throw new ApiError(
        `Connection could not be verified: ${safeMcpVerificationError(error)}`,
        422,
        'CONNECTION_VERIFICATION_FAILED',
      )
    }
  }

  const connection = await prisma.mcpConnection.update({
    where: { id: body.id, organizationId: auth.organizationId },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.serverUrl !== undefined && { serverUrl: body.serverUrl }),
      authType: newAuthType,
      authConfig: authConfig as Prisma.InputJsonValue,
      ...(body.isActive !== undefined && { isActive: body.isActive }),
      ...(verifiedAt && { lastVerifiedAt: verifiedAt }),
    },
  })

  // Bust cached tool discovery so a changed serverUrl/auth is picked up now,
  // not after the TTL.
  await cacheDelete(toolDiscoveryCacheKey(auth.organizationId, existing.serverUrl))
  if (body.serverUrl && body.serverUrl !== existing.serverUrl) {
    await cacheDelete(toolDiscoveryCacheKey(auth.organizationId, body.serverUrl))
  }

  return { success: true, connection: serializeConnection(connection) }
}, { permission: 'integration.manage' })

// ── DELETE — remove a connection ──────────────────────────────────────────

export const DELETE = withAuthenticatedApi(async (request, auth) => {
  // Support id in JSON body or query param
  let id: string | undefined

  const url = new URL(request.url)
  const queryId = url.searchParams.get('id')

  if (queryId) {
    id = queryId
  } else {
    const body = z
      .object({ id: z.string().min(1) })
      .parse(await request.json())
    id = body.id
  }

  const existing = await prisma.mcpConnection.findFirst({
    where: { id, organizationId: auth.organizationId },
  })
  if (!existing) throw new ApiError('MCP connection not found', 404, 'NOT_FOUND')
  if (existing.provider) {
    throw new ApiError('This connection is managed by the platform and cannot be edited or deleted.', 403, 'PROVIDER_MANAGED')
  }

  await prisma.mcpConnection.delete({ where: { id: existing.id, organizationId: auth.organizationId } })

  return { success: true }
}, { permission: 'integration.manage' })
