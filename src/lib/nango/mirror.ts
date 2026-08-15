import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getNangoClient, NANGO_ORG_TAG } from './client'
import { recordCredentialGrant } from '@/lib/credentials/audit'
import { reviewScopes, type ScopeReview } from '@/lib/credentials/scopes'

export type NangoConnectionStatus = {
  connected: boolean
  connectionIds: string[]
  provider: string
  error?: string
  lastSync?: string
  verifiedAt?: string
  /**
   * Scope review for the grant Nango holds. Empty `granted` means "not
   * recorded" — Nango only reveals the scope when a connection is verified —
   * rather than "this connection has no scopes".
   */
  scopes?: ScopeReview
}

/**
 * List an organization's Nango connections (live from Nango) and mirror them
 * into the per-org `nango_connections` table, reconciling deletions. Nango owns
 * the credentials; the mirror stores only connection ids + health so the agent
 * runtime (resolveNangoConnection) can resolve a provider connection without a
 * live round-trip on every tool call.
 *
 * Shared by GET /api/nango/status (populates the mirror on page view) and the
 * Nango webhook (populates it on connection events) — so a headless/scheduled
 * agent run can resolve a freshly-connected account even before anyone reopens
 * the integrations page. Returns per-config-key status for the UI.
 */
export async function syncOrgNangoConnections(
  organizationId: string,
): Promise<Record<string, NangoConnectionStatus>> {
  const response = await getNangoClient().listConnections({
    tags: { [NANGO_ORG_TAG]: organizationId },
    // Explicit high limit: a capped/partial first page would make `seen` a
    // subset and the reconcile below over-delete. Workspaces have far fewer
    // than this many connections.
    limit: 1000,
  })

  const connections: Record<string, NangoConnectionStatus> = {}
  const seen: string[] = []
  const existingRows = await prisma.nangoConnection.findMany({
    where: { organizationId },
    select: { connectionId: true, metadata: true, grantedScopes: true },
  })
  const existingByConnectionId = new Map(existingRows.map((row) => [row.connectionId, row.metadata]))
  const scopesByConnectionId = new Map(existingRows.map((row) => [row.connectionId, row.grantedScopes]))

  for (const connection of response.connections ?? []) {
    seen.push(connection.connection_id)
    const errors = connection.errors ?? []
    const existingMetadata = existingByConnectionId.get(connection.connection_id)
    const existingRecord =
      existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
        ? (existingMetadata as Record<string, unknown>)
        : {}
    const verification =
      existingRecord.verification &&
      typeof existingRecord.verification === 'object' &&
      !Array.isArray(existingRecord.verification)
        ? (existingRecord.verification as Record<string, unknown>)
        : undefined
    const verificationFailed = verification?.status === 'error'
    const connected = errors.length === 0 && !verificationFailed
    const error = verificationFailed
      ? String(verification?.error || 'Provider credentials could not be verified.')
      : connected
        ? undefined
        : `Connection needs attention (${errors[0].type})`
    const verifiedAt =
      verification?.status === 'verified' && typeof verification.verifiedAt === 'string'
        ? verification.verifiedAt
        : undefined
    const endUser = connection.end_user
    const key = connection.provider_config_key

    const existing = connections[key]
    // Merge scopes across every connection under one provider key: the review
    // has to reflect the widest access the workspace actually holds, not
    // whichever connection happened to be listed last.
    const mergedScopes = [
      ...new Set([...(existing?.scopes?.granted ?? []), ...(scopesByConnectionId.get(connection.connection_id) ?? [])]),
    ]
    connections[key] = {
      connected: existing ? existing.connected || connected : connected,
      connectionIds: [...(existing?.connectionIds ?? []), connection.connection_id],
      provider: connection.provider,
      error: existing?.error ?? error,
      lastSync: connection.created,
      verifiedAt: existing?.verifiedAt ?? verifiedAt,
      scopes: reviewScopes(connection.provider ?? key, mergedScopes),
    }

    const metadata = {
      ...existingRecord,
      nango: {
        connectionId: connection.connection_id,
        providerConfigKey: key,
        provider: connection.provider,
        endUserId: endUser?.id ?? null,
        errors,
      },
    } satisfies Prisma.InputJsonObject

    const isNewToUs = !existingByConnectionId.has(connection.connection_id)

    const row = await prisma.nangoConnection.upsert({
      where: {
        organizationId_connectionId: {
          organizationId,
          connectionId: connection.connection_id,
        },
      },
      update: {
        providerConfigKey: key,
        provider: connection.provider,
        status: connected ? 'connected' : 'error',
        lastError: error ?? null,
        metadata,
      },
      create: {
        organizationId,
        userId: endUser?.id ?? null,
        connectionId: connection.connection_id,
        providerConfigKey: key,
        provider: connection.provider,
        status: connected ? 'connected' : 'error',
        lastError: error ?? null,
        metadata,
      },
    })

    // Only the FIRST time we see a connection. This sync re-runs on every
    // webhook and every connections-page load, so auditing each upsert would
    // emit a grant event for connections that have existed for months and
    // drown the ones that are actually new.
    //
    // Nango holds the credential itself, so this is where an authorization it
    // brokered becomes visible to us at all — without it, a connected account
    // appears in the workspace with no record of when or by whom.
    if (isNewToUs) {
      await recordCredentialGrant({
        organizationId,
        kind: 'nango_connection',
        credentialId: row.id,
        provider: connection.provider ?? key,
        ownerUserId: endUser?.id ?? null,
        // The end user Nango attributes the connection to. Null means it was
        // established as an org-shared connection, which is itself worth seeing.
        actorUserId: endUser?.id ?? null,
        method: 'nango_oauth',
      })
    }
  }

  // Drop mirror rows for connections that no longer exist in Nango — but ONLY
  // against a non-empty snapshot. A transient empty/partial listConnections
  // (Nango tag-index eventual consistency right after a connect, or a backend
  // hiccup) would otherwise wipe the org's whole mirror via `notIn: []`,
  // silently disconnecting every integration until the next full sync. Better
  // to leave a stale row (a dead connection resolves and the tool call 404s
  // once) than to disconnect everything. Genuine single-connection removals are
  // handled directly by the DELETE /api/nango/connections route.
  if (seen.length > 0) {
    await prisma.nangoConnection.deleteMany({
      where: { organizationId, connectionId: { notIn: seen } },
    })
  }

  return connections
}
