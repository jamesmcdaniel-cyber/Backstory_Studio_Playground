/**
 * ensureFreshConnectionToken — persist refreshed OAuth authcode tokens.
 *
 * Called in execute-agent.ts just before mcpConfigFromConnection() so every
 * agent run starts with a valid, DB-backed access token.
 *
 * Design goals:
 *  - Coalesce concurrent refreshes per connection id so two simultaneous
 *    agent runs don't race to double-refresh (and potentially invalidate each
 *    other's refresh tokens).
 *  - Never throw — on any error, warn and return the original conn so the
 *    McpClient falls through to its own in-memory refresh path.
 *  - Never include token values in log messages.
 */

import { Prisma } from '@prisma/client'
import { prisma, systemPrisma } from '@/lib/prisma'
import { apiLogger } from '@/lib/logger'
import { encryptSecret, decryptSecret } from '@/lib/crypto/secrets'
import { refreshAccessToken, type TokenResponse } from '@/lib/mcp/oauth-authcode'
import { recordCredentialRotation } from '@/lib/credentials/audit'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimum shape required from the Prisma McpConnection row.
 * The generic T extends this so the original Prisma type flows through.
 */
export interface McpConnectionLike {
  id: string
  authType: string
  authConfig: unknown
}

interface AuthcodeAuthConfig {
  flow: 'authcode'
  clientId: string
  clientSecret?: string    // encrypted
  tokenEndpoint: string
  accessToken?: string     // encrypted
  refreshToken?: string    // encrypted
  expiresAt?: number       // ms since epoch
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Module-level coalescing map: connectionId → in-flight refresh promise
// ---------------------------------------------------------------------------

const inFlight = new Map<string, Promise<any>>()

// ---------------------------------------------------------------------------
// Shared persistence: encrypt refreshed tokens and write them back to the row.
// Used by the pre-run helper below AND by McpClient's mid-run refresh callback,
// so a rotated refresh_token is never lost (which would break the next run).
// ---------------------------------------------------------------------------

export async function persistRefreshedAuthcodeTokens(
  connectionId: string,
  currentAuthConfig: Record<string, unknown>,
  tokens: TokenResponse,
  fallbackRefreshToken: string,
): Promise<Record<string, unknown>> {
  const newAuthConfig: Record<string, unknown> = {
    ...currentAuthConfig,
    accessToken: encryptSecret(tokens.access_token),
    // Keep the old refresh_token if the server didn't rotate it.
    refreshToken: encryptSecret(tokens.refresh_token ?? fallbackRefreshToken),
    expiresAt:
      Date.now() +
      (typeof tokens.expires_in === 'number' && tokens.expires_in > 0 ? tokens.expires_in : 3600) * 1000,
  }

  // systemPrisma: OAuth token refresh keyed by globally-unique connection id (resolved org-scoped upstream).
  const updated = await systemPrisma.mcpConnection.update({
    where: { id: connectionId },
    data: { authConfig: newAuthConfig as Prisma.InputJsonValue },
    select: { organizationId: true, userId: true, provider: true },
  })

  // A refresh replaces live credential material, so it is a rotation and is
  // recorded as one. Without this, the only trace of a token changing hands is
  // an opaque `updatedAt` bump — and a refresh_token that the provider rotated
  // out from under us looks identical to one that was never touched.
  await recordCredentialRotation({
    organizationId: updated.organizationId,
    kind: 'mcp_connection',
    credentialId: connectionId,
    provider: updated.provider,
    ownerUserId: updated.userId,
    actorUserId: null,
    method: 'oauth_refresh',
    reason: tokens.refresh_token ? 'provider_rotated_refresh_token' : 'access_token_expiry',
  })

  return newAuthConfig
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * If `conn` is an oauth2 authcode connection whose access token is expired (or
 * missing / expiring within 60 s), refresh it via the stored refresh_token,
 * persist the new tokens to the DB, and return the updated connection object.
 *
 * Returns `conn` unchanged for non-oauth2 connections, non-authcode flows,
 * and on any error (never throws).
 *
 * Generic T preserves the full Prisma row type at the call site.
 */
export async function ensureFreshConnectionToken<T extends McpConnectionLike>(
  conn: T,
): Promise<T> {
  // Fast-path: not an oauth2 authcode connection
  if (conn.authType !== 'oauth2') return conn

  const stored =
    conn.authConfig &&
    typeof conn.authConfig === 'object' &&
    !Array.isArray(conn.authConfig)
      ? (conn.authConfig as Record<string, unknown>)
      : {}

  if (stored.flow !== 'authcode') return conn

  const cfg = stored as AuthcodeAuthConfig

  // Decrypt and check the stored access token
  try {
    const accessToken = cfg.accessToken ? decryptSecret(cfg.accessToken) : null
    const expiresAt = typeof cfg.expiresAt === 'number' ? cfg.expiresAt : 0

    // Still valid with a 60-second safety margin — nothing to do
    if (accessToken && expiresAt > Date.now() + 60_000) {
      return conn
    }
  } catch {
    // Decryption failed — fall through to refresh attempt
  }

  // Coalesce: if a refresh is already in-flight for this connection, wait
  // for it instead of issuing a second one.
  const existing = inFlight.get(conn.id) as Promise<T> | undefined
  if (existing) return existing

  const refreshPromise = _doRefresh(conn, cfg)
  inFlight.set(conn.id, refreshPromise)

  try {
    return await refreshPromise
  } finally {
    inFlight.delete(conn.id)
  }
}

// ---------------------------------------------------------------------------
// Internal refresh + persist (never throws — errors return conn unchanged)
// ---------------------------------------------------------------------------

async function _doRefresh<T extends McpConnectionLike>(
  conn: T,
  cfg: AuthcodeAuthConfig,
): Promise<T> {
  try {
    const { clientId, tokenEndpoint } = cfg

    if (!clientId || !tokenEndpoint) {
      apiLogger.warn('ensureFreshConnectionToken: missing clientId or tokenEndpoint, skipping refresh', {
        connectionId: conn.id,
      })
      return conn
    }

    if (!cfg.refreshToken) {
      apiLogger.warn('ensureFreshConnectionToken: no refreshToken stored, skipping refresh', {
        connectionId: conn.id,
      })
      return conn
    }

    // Decrypt secrets for the refresh call
    let refreshToken: string
    let clientSecret: string | undefined

    try {
      refreshToken = decryptSecret(cfg.refreshToken)
      clientSecret = cfg.clientSecret ? decryptSecret(cfg.clientSecret) : undefined
    } catch {
      apiLogger.warn('ensureFreshConnectionToken: failed to decrypt stored secrets, skipping refresh', {
        connectionId: conn.id,
      })
      return conn
    }

    // Call the token endpoint
    const tokens = await refreshAccessToken(tokenEndpoint, {
      clientId,
      clientSecret,
      refreshToken,
    })

    // Encrypt + persist the refreshed tokens (shared with the mid-run path).
    const newAuthConfig = await persistRefreshedAuthcodeTokens(
      conn.id,
      cfg as Record<string, unknown>,
      tokens,
      refreshToken,
    )

    // Return updated conn object so the caller's mcpConfigFromConnection() call
    // sees the fresh tokens without a second DB round-trip.
    return { ...conn, authConfig: newAuthConfig as unknown }  as T
  } catch (err) {
    apiLogger.warn('ensureFreshConnectionToken: refresh/persist failed, using existing token', {
      connectionId: conn.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return conn
  }
}
