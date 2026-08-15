/**
 * People.ai MCP client.
 *
 * Two auth strategies against https://mcp.people.ai/mcp:
 *  - user:    the caller's own `mcp_*` bearer from their PeopleAiConnection
 *             (per-user data isolation; refresh-on-401 with persistence)
 *  - service: PAI-Client-Id / PAI-Client-Secret headers (org-level API key)
 *             for non-interactive runs (signals) — access follows the key.
 */

import { prisma, systemPrisma } from '@/lib/prisma'
import { decryptSecret, encryptSecret } from '@/lib/crypto/secrets'
import { apiLogger } from '@/lib/logger'
import { recordCredentialUse, recordCredentialUseFailure } from '@/lib/credentials/audit'
import { StreamableHttpMcpClient, type McpToolDescriptor } from '@/lib/mcp/streamable-http'
import { discoverMetadata, envOAuthConfig, refreshTokens, PEOPLE_AI_MCP_BASE_URL } from './oauth'

export type PeopleAiAuth =
  | { kind: 'user'; connectionId: string; accessToken: string; refreshToken?: string }
  | { kind: 'service'; clientId: string; clientSecret: string }

export interface PeopleAiClientOptions {
  fetchImpl?: typeof fetch
  baseUrl?: string
  /** Per-call MCP request ceiling. Defaults to DEFAULT_MCP_TIMEOUT_MS. */
  timeoutMs?: number
}

// Per-call ceiling for People.ai MCP requests. Deliberately well under both the
// interactive request budget (a chat turn / inline agent run) and any job
// budget, so a slow or unresponsive Sales AI endpoint fails fast instead of
// dominating the caller. The transport's own fallback is 30s; we tighten it
// here because Sales AI sits on hot paths (tool loading, enrichment). Tunable
// via PEOPLE_AI_MCP_TIMEOUT_MS for environments with a slower endpoint.
// Guard the parse: a truthy-but-invalid value ('-5', '10.5', 'abc') must not
// reach AbortSignal.timeout (which throws a RangeError on negatives/NaN). Only
// a finite positive integer wins; anything else falls back to 20s.
const parsedMcpTimeout = Math.floor(Number(process.env.PEOPLE_AI_MCP_TIMEOUT_MS))
const DEFAULT_MCP_TIMEOUT_MS = Number.isFinite(parsedMcpTimeout) && parsedMcpTimeout > 0 ? parsedMcpTimeout : 20_000

export class PeopleAiClient {
  private readonly transport: StreamableHttpMcpClient
  readonly serverUrl: string
  readonly authKind: PeopleAiAuth['kind']

  constructor(private auth: PeopleAiAuth, options: PeopleAiClientOptions = {}) {
    const base = (options.baseUrl || process.env.PEOPLE_AI_MCP_BASE_URL || PEOPLE_AI_MCP_BASE_URL).replace(/\/$/, '')
    this.serverUrl = `${base}/mcp`
    this.authKind = auth.kind
    this.transport = new StreamableHttpMcpClient({
      clientName: 'BackstoryStudio',
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
      getHeaders: async () => this.headers(),
      onUnauthorized: async () => this.recoverAuth(options),
    })
  }

  private headers(): Record<string, string> {
    if (this.auth.kind === 'user') {
      return { Authorization: `Bearer ${this.auth.accessToken}` }
    }
    return {
      'PAI-Client-Id': this.auth.clientId,
      'PAI-Client-Secret': this.auth.clientSecret,
    }
  }

  /** 401 recovery: refresh the user's mcp_* token and persist the new pair. */
  private async recoverAuth(options: PeopleAiClientOptions): Promise<boolean> {
    if (this.auth.kind !== 'user' || !this.auth.refreshToken) return false
    const oauth = envOAuthConfig('unused://refresh-only')
    if (!oauth) return false
    try {
      const metadata = await discoverMetadata({ ...oauth, fetchImpl: options.fetchImpl })
      const tokens = await refreshTokens(
        { ...oauth, fetchImpl: options.fetchImpl },
        { tokenEndpoint: metadata.tokenEndpoint, refreshToken: this.auth.refreshToken },
      )
      this.auth = { ...this.auth, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
      // systemPrisma: token refresh keyed by globally-unique connection id (resolved org-scoped upstream).
      await systemPrisma.peopleAiConnection.update({
        where: { id: this.auth.connectionId },
        data: {
          accessToken: encryptSecret(tokens.accessToken),
          refreshToken: tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
          status: 'active',
          lastVerifiedAt: new Date(),
        },
      })
      return true
    } catch (error) {
      apiLogger.warn('People.ai token refresh failed', {
        connectionId: this.auth.connectionId,
        error: error instanceof Error ? error.message : String(error),
      })
      await prisma.peopleAiConnection
        .update({ where: { id: this.auth.connectionId }, data: { status: 'refresh_failed' } }) // systemPrisma below
        .catch(() => undefined)
      return false
    }
  }

  listTools(): Promise<McpToolDescriptor[]> {
    return this.transport.getServerTools(this.serverUrl)
  }

  callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.transport.callTool(this.serverUrl, name, args)
  }
}

// ── Factories ───────────────────────────────────────────────────────────────

/**
 * User-scoped client from the caller's stored People.ai connection.
 * Returns null when the user has no usable connection.
 */
export async function getPeopleAiClientForUser(
  userId: string,
  organizationId: string,
  options: PeopleAiClientOptions = {},
): Promise<PeopleAiClient | null> {
  const connection = await prisma.peopleAiConnection.findFirst({
    // findFirst, not findUnique: the credential owner guard injects an
    // owner-liveness filter, and findUnique's where clause accepts only unique
    // fields so it cannot carry one. The compound unique is spelled out here.
    where: { organizationId, userId },
  })
  if (!connection || connection.status === 'revoked') return null
  try {
    const client = new PeopleAiClient(
      {
        kind: 'user',
        connectionId: connection.id,
        accessToken: decryptSecret(connection.accessToken),
        refreshToken: connection.refreshToken ? decryptSecret(connection.refreshToken) : undefined,
      },
      options,
    )
    await recordCredentialUse({
      organizationId,
      kind: 'people_ai_connection',
      credentialId: connection.id,
      provider: 'people_ai',
      ownerUserId: userId,
      actorUserId: userId,
      consumer: 'peopleai.client',
    })
    return client
  } catch (error) {
    await recordCredentialUseFailure({
      organizationId,
      kind: 'people_ai_connection',
      credentialId: connection.id,
      provider: 'people_ai',
      ownerUserId: userId,
      actorUserId: userId,
      consumer: 'peopleai.client',
      reason: 'decrypt_failed',
    })
    apiLogger.warn('People.ai connection unusable (decrypt failed)', {
      connectionId: connection.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Service client from org-level API credentials (PAI-Client-Id/Secret).
 * Used for non-interactive runs; access follows the key, not a user.
 */
export function getPeopleAiServiceClient(options: PeopleAiClientOptions = {}): PeopleAiClient | null {
  const clientId = process.env.PEOPLE_AI_SERVICE_CLIENT_ID
  const clientSecret = process.env.PEOPLE_AI_SERVICE_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return new PeopleAiClient({ kind: 'service', clientId, clientSecret }, options)
}

/**
 * The Sales AI client for READING context (assistant brain, RAG indexing).
 * Native/OOTB by design: the org service credential is the default so context
 * works with zero user setup; a caller's own connection is preferred when
 * available for rep-scoped fidelity. Returns null only when neither is set.
 */
export async function getPeopleAiReadClient(
  userId: string | null,
  organizationId: string,
  options: PeopleAiClientOptions = {},
): Promise<PeopleAiClient | null> {
  if (userId) {
    const userClient = await getPeopleAiClientForUser(userId, organizationId, options)
    if (userClient) return userClient
  }
  return getPeopleAiServiceClient(options)
}
