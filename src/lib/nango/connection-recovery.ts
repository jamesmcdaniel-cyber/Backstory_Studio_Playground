/**
 * Recovering from a mirror that points at a connection Nango no longer has.
 *
 * `nango_connections` is our copy of Nango's connections, refreshed when
 * someone opens Integrations or when a webhook arrives. `resolveNangoConnection`
 * already self-heals a COLD mirror: resolve nothing, reconcile once, retry.
 *
 * It cannot heal a STALE one. A row left over from a connection that was
 * replaced — reconnecting mints a new Nango connection id — still says
 * `connected`, so resolution succeeds, returns the dead id, and short-circuits
 * before the reconcile branch is ever reached. Nango then rejects the id at its
 * own edge, fast, and every tool call for that provider fails with a 4xx that
 * never reaches the provider. Reconnecting does not fix it, because the thing
 * that is wrong is the row the reconnect did not remove.
 *
 * A stale row is worse than no row: no row heals itself, a stale one never
 * does. So the rejection itself becomes the signal — the same reconcile the
 * cold path runs, triggered by Nango telling us the reference is dead.
 */

import { apiLogger } from '@/lib/logger'
import { upstreamDetail } from '@/lib/upstream-error'
import type { DeliveryConnection } from './delivery'

/** Nango's phrasing for a reference it cannot resolve. */
const UNKNOWN_REFERENCE =
  /(unknown|invalid|no such|not\s+found|does\s+not\s+exist).{0,40}(connection|provider[_\s-]?config)|(connection|provider[_\s-]?config[_\s-]?key)\b.{0,40}(not\s+found|unknown|invalid|does\s+not\s+exist)/i

/**
 * Whether a failure means "the connection reference we sent is dead", as
 * opposed to "the provider rejected what we asked it to do".
 *
 * Deliberately narrow. A 401/403 is a credential problem that reconciling
 * cannot fix, and a 5xx is the provider's, not ours — treating either as a
 * stale mirror would resync on every transient failure. Only a 4xx whose body
 * names the connection or the provider config key qualifies.
 */
export function isUnknownConnectionError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status
  if (typeof status !== 'number') return false
  if (status < 400 || status >= 500) return false
  if (status === 401 || status === 403) return false
  const detail = upstreamDetail(error)
  return detail ? UNKNOWN_REFERENCE.test(detail) : false
}

/**
 * Run a Nango-backed call, and if Nango rejects the connection reference,
 * reconcile the mirror once and retry with whatever it resolves to.
 *
 * The mirror's own sync already deletes superseded rows, so this is the case
 * that sync has not reached: a connection replaced since the plane resolved it
 * (agent runs resolve once at load and hold the result for the whole run), or
 * a row left behind by a listing that could not see it. `resolveNangoConnection`
 * heals a cold mirror on a resolution MISS; this heals a dead HIT, which the
 * miss path structurally cannot see.
 *
 * One retry only. If the freshly-reconciled connection is rejected too, the
 * problem is not staleness and looping would just spend the provider's rate
 * limit on the same answer.
 */
export async function withStaleConnectionRecovery<T>(params: {
  organizationId: string
  providerConfigKeys: readonly string[]
  userId?: string | null
  connection: DeliveryConnection
  call: (connection: DeliveryConnection) => Promise<T>
}): Promise<T> {
  try {
    return await params.call(params.connection)
  } catch (error) {
    if (!isUnknownConnectionError(error)) throw error

    apiLogger.warn('nango: connection reference rejected, reconciling mirror and retrying once', {
      organizationId: params.organizationId,
      connectionId: params.connection.connectionId,
      providerConfigKey: params.connection.providerConfigKey,
    })

    let fresh: DeliveryConnection | null = null
    try {
      const { syncOrgNangoConnections } = await import('./mirror')
      await syncOrgNangoConnections(params.organizationId)
      const { resolveNangoConnection } = await import('./delivery')
      fresh = await resolveNangoConnection(
        params.organizationId,
        params.providerConfigKeys,
        params.userId,
      )
    } catch {
      // Reconciliation is best-effort: a Nango outage here must surface the
      // ORIGINAL failure, not a second one about the recovery attempt.
      throw error
    }

    // Nothing new to try: the same dead reference, or none at all. The original
    // rejection is the honest thing to report.
    if (!fresh || fresh.connectionId === params.connection.connectionId) throw error
    return params.call(fresh)
  }
}
