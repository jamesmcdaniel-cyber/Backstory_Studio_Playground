import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { cachePing } from '@/lib/cache'
import { encryptionConfigured } from '@/lib/crypto/secrets'
import { neo4jPing } from '@/lib/rag/neo4j-store'
import { apiLogger } from '@/lib/logger'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Readiness probe. Postgres is the only CRITICAL dependency for serving — if
 * it's down we return 503 so load balancers / deploy gates / uptime monitors
 * see the outage. The cache (Redis) and Neo4j degrade gracefully (best-effort
 * RAG + fall-through cache), so they're reported but never fail the check.
 */
export async function GET() {
  const [db, cache, neo4j] = await Promise.all([
    probe(async () => { await prisma.$queryRaw`SELECT 1` }),
    cachePing().then((c) => ({ ok: c.ok, configured: c.configured })).catch(() => ({ ok: false, configured: false })),
    neo4jPing().catch(() => ({ ok: false, configured: false })),
  ])

  const healthy = db.ok // only Postgres is critical to serving
  return NextResponse.json(
    { status: healthy ? 'ok' : 'unhealthy', timestamp: new Date().toISOString(), checks: { db, cache, neo4j, secrets: { encrypted: encryptionConfigured() } } },
    { status: healthy ? 200 : 503 },
  )
}

async function probe(fn: () => Promise<void>): Promise<{ ok: boolean; ms?: number }> {
  const start = Date.now()
  try {
    await fn()
    return { ok: true, ms: Date.now() - start }
  } catch (error) {
    // Never return the raw error to this ANONYMOUS endpoint — a DB failure
    // message leaks the host:port topology. Log server-side; report only up/down.
    apiLogger.error('health probe failed', { error: error instanceof Error ? error.message : String(error) })
    return { ok: false }
  }
}
