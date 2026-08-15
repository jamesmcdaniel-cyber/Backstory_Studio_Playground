import { Prisma } from '@prisma/client'
import { getNangoClient } from '@/lib/nango/client'
import { syncOrgNangoConnections } from '@/lib/nango/mirror'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { normalizeScopes } from '@/lib/credentials/audit'

export const runtime = 'nodejs'

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Provider rejected the credentials'
  return message.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 240)
}

/**
 * Force Nango to resolve and refresh every credential for one integration.
 * A connection is only "verified" after this succeeds; merely completing the
 * Connect UI is not treated as proof that the provider token is usable.
 */
/**
 * Pull the granted scope out of a Nango connection record. Nango normalises
 * OAuth2 credentials but passes the provider's raw token response through, and
 * providers put scope in either place — so both are checked before giving up.
 */
function scopesFromNangoConnection(connection: unknown): string[] {
  if (!connection || typeof connection !== 'object') return []
  const credentials = (connection as { credentials?: unknown }).credentials
  if (!credentials || typeof credentials !== 'object') return []

  const direct = (credentials as { scope?: unknown }).scope
  const raw = (credentials as { raw?: unknown }).raw
  const fromRaw = raw && typeof raw === 'object' ? (raw as { scope?: unknown }).scope : undefined

  return normalizeScopes(
    typeof direct === 'string' ? direct : typeof fromRaw === 'string' ? fromRaw : null,
  ) ?? []
}

export const POST = withAuthenticatedApi(async (request, auth) => {
  const segments = request.nextUrl.pathname.split('/').filter(Boolean)
  const integrationId = decodeURIComponent(segments.at(-2) ?? '')
  if (!integrationId) throw new ApiError('Integration id is required', 400, 'INVALID_REQUEST')

  let connectionIds: string[] = []
  // Nango's tag index can lag the Connect UI event briefly. Retry the live
  // mirror lookup so "connected" is not immediately followed by a false 404.
  for (let attempt = 0; attempt < 3 && connectionIds.length === 0; attempt++) {
    const statuses = await syncOrgNangoConnections(auth.organizationId)
    connectionIds = statuses[integrationId]?.connectionIds ?? []
    if (!connectionIds.length && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)))
    }
  }
  if (!connectionIds.length) {
    throw new ApiError(
      'The account was not found after connecting. Reopen the connection flow and try again.',
      404,
      'CONNECTION_NOT_FOUND',
    )
  }

  const client = getNangoClient()
  const verifiedAt = new Date()
  const results = await Promise.all(
    connectionIds.map(async (connectionId) => {
      try {
        // forceRefresh + refreshToken make Nango resolve the current provider
        // credential instead of returning a stale cached connection record.
        const connection = await client.getConnection(integrationId, connectionId, true, true)
        // The one point where Nango hands us the resolved credential. It holds
        // the secret — by design — so this is the only place the granted scope
        // is observable at all; listConnections does not carry it.
        return { connectionId, ok: true as const, scopes: scopesFromNangoConnection(connection) }
      } catch (error) {
        return { connectionId, ok: false as const, error: safeError(error), scopes: [] as string[] }
      }
    }),
  )

  await Promise.all(
    results.map(async (result) => {
      const row = await prisma.nangoConnection.findFirst({
        // findFirst: the owner-liveness filter cannot be injected into a
        // findUnique where clause.
        where: {
          organizationId: auth.organizationId,
          connectionId: result.connectionId,
        },
      })
      if (!row) return
      const current =
        row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
          ? (row.metadata as Record<string, unknown>)
          : {}
      const metadata = {
        ...current,
        verification: result.ok
          ? { status: 'verified', verifiedAt: verifiedAt.toISOString() }
          : { status: 'error', checkedAt: verifiedAt.toISOString(), error: result.error },
      } satisfies Prisma.InputJsonObject
      await prisma.nangoConnection.update({
        where: { id: row.id, organizationId: auth.organizationId },
        data: {
          status: result.ok ? 'connected' : 'error',
          lastError: result.ok ? null : result.error,
          metadata,
          // Only overwrite when we actually observed scopes: a failed verify
          // returns none, and blanking a previously recorded grant would make
          // the review surface read "no scopes" for a live connection.
          ...(result.scopes.length ? { grantedScopes: result.scopes } : {}),
        },
      })
    }),
  )

  const failed = results.filter((result) => !result.ok)
  if (failed.length === results.length) {
    throw new ApiError(
      `The provider connection exists, but its credentials could not be verified: ${failed[0]?.error ?? 'Reconnect the account.'}`,
      422,
      'CONNECTION_VERIFICATION_FAILED',
    )
  }

  return {
    success: true,
    verifiedAt: verifiedAt.toISOString(),
    verifiedAccounts: results.length - failed.length,
    failedAccounts: failed.length,
  }
}, { permission: 'integration.manage' })
