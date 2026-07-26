import { Prisma } from '@prisma/client'
import { getNangoClient } from '@/lib/nango/client'
import { syncOrgNangoConnections } from '@/lib/nango/mirror'
import { prisma } from '@/lib/prisma'
import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'

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
export const POST = withAuthenticatedApi(async (request, auth) => {
  const segments = request.nextUrl.pathname.split('/').filter(Boolean)
  const integrationId = decodeURIComponent(segments.at(-2) ?? '')
  if (!integrationId) throw new ApiError('Integration id is required', 400, 'INVALID_REQUEST')

  const statuses = await syncOrgNangoConnections(auth.organizationId)
  const connectionIds = statuses[integrationId]?.connectionIds ?? []
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
        await client.getConnection(integrationId, connectionId, true, true)
        return { connectionId, ok: true as const }
      } catch (error) {
        return { connectionId, ok: false as const, error: safeError(error) }
      }
    }),
  )

  await Promise.all(
    results.map(async (result) => {
      const row = await prisma.nangoConnection.findUnique({
        where: {
          organizationId_connectionId: {
            organizationId: auth.organizationId,
            connectionId: result.connectionId,
          },
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
        where: { id: row.id },
        data: {
          status: result.ok ? 'connected' : 'error',
          lastError: result.ok ? null : result.error,
          metadata,
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
})
