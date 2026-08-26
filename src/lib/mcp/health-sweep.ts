import { systemPrisma } from '@/lib/prisma'
import { safeMcpVerificationError, verifyLiveMcpConnection } from '@/lib/mcp/verify-connection'

const MAX_PER_SWEEP = 20
const STALE_MS = 6 * 60 * 60_000

/**
 * Seam for tests only. Verification talks to a third-party server over HTTPS
 * and the SSRF guard refuses every address a test could stand one up on, so the
 * healthy and schema-drift outcomes are otherwise unreachable. Production
 * callers pass nothing and get {@link verifyLiveMcpConnection}.
 */
export interface McpHealthSweepDeps {
  verify?: typeof verifyLiveMcpConnection
}

/** Bounded background verification with persisted schema-drift state. */
export async function sweepMcpConnectionHealth(
  now = new Date(),
  deps: McpHealthSweepDeps = {},
): Promise<{ checked: number; unhealthy: number; changed: number }> {
  // verifyLiveMcpConnection, not the config-level one: this sweep runs
  // unattended against connections nobody is watching, and an OAuth refresh it
  // triggers must be SAVED. Refreshing with a rotating provider and discarding
  // the replacement spends the stored credential — which turned this
  // health check into the thing that made connections unhealthy.
  const verify = deps.verify ?? verifyLiveMcpConnection
  // systemPrisma: bounded cross-tenant health sweep from authenticated cron.
  const connections = await systemPrisma.mcpConnection.findMany({
    where: { isActive: true, OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: new Date(now.getTime() - STALE_MS) } }] },
    orderBy: { lastVerifiedAt: { sort: 'asc', nulls: 'first' } },
    take: MAX_PER_SWEEP,
  })
  let unhealthy = 0
  let changed = 0
  // Deliberately sequential: third-party MCP servers must not receive a burst
  // simply because many workspace connections became stale together.
  for (const connection of connections) {
    try {
      const verification = await verify(connection)
      const schemaChanged = Boolean(connection.toolSchemaHash && connection.toolSchemaHash !== verification.schemaHash)
      if (schemaChanged) changed += 1
      // systemPrisma: result write for the globally selected connection row.
      await systemPrisma.mcpConnection.update({
        where: { id: connection.id },
        data: {
          lastVerifiedAt: verification.verifiedAt,
          healthStatus: schemaChanged ? 'schema_changed' : 'healthy',
          lastError: null,
          toolSchemaHash: verification.schemaHash,
        },
      })
    } catch (error) {
      unhealthy += 1
      // systemPrisma: failure write for the globally selected connection row.
      await systemPrisma.mcpConnection.update({
        where: { id: connection.id },
        data: { lastVerifiedAt: now, healthStatus: 'unhealthy', lastError: safeMcpVerificationError(error) },
      }).catch(() => undefined)
    }
  }
  return { checked: connections.length, unhealthy, changed }
}
