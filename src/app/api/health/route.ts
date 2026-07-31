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
 *
 * This endpoint is anonymous and fans out to three backends, one of which
 * (neo4jPing) opens and closes a driver per call. That combination is an
 * amplifier: a few requests a second turn into a few hundred backend
 * connections a second, from anyone who knows the URL. So the result is cached
 * for a short window and every caller inside it gets the same answer.
 *
 * The window is deliberately short. A readiness probe that lags reality is
 * worse than a slow one — an uptime monitor polling every 30s must not be told
 * about a Postgres outage a minute late.
 */
const PROBE_TTL_MS = Number(process.env.HEALTH_PROBE_TTL_MS) || 5_000

type HealthSnapshot = { body: Record<string, unknown>; healthy: boolean }
let lastProbe: { at: number; snapshot: HealthSnapshot } | null = null
// Coalesce concurrent misses so a burst produces ONE backend fan-out, not one
// per request — the cache alone doesn't help against simultaneous arrivals.
let inFlight: Promise<HealthSnapshot> | null = null

async function runProbes(): Promise<HealthSnapshot> {
  const [db, cache, neo4j] = await Promise.all([
    probe(async () => { await prisma.$queryRaw`SELECT 1` }),
    cachePing().then((c) => ({ ok: c.ok, configured: c.configured })).catch(() => ({ ok: false, configured: false })),
    neo4jPing().catch(() => ({ ok: false, configured: false })),
  ])
  const healthy = db.ok // only Postgres is critical to serving
  return {
    healthy,
    body: {
      status: healthy ? 'ok' : 'unhealthy',
      timestamp: new Date().toISOString(),
      checks: { db, cache, neo4j, secrets: { encrypted: encryptionConfigured() } },
    },
  }
}

export async function GET() {
  const now = Date.now()
  if (lastProbe && now - lastProbe.at < PROBE_TTL_MS) {
    return NextResponse.json(lastProbe.snapshot.body, { status: lastProbe.snapshot.healthy ? 200 : 503 })
  }

  inFlight ??= runProbes()
    .then((snapshot) => {
      lastProbe = { at: Date.now(), snapshot }
      return snapshot
    })
    .finally(() => {
      inFlight = null
    })

  const snapshot = await inFlight
  return NextResponse.json(snapshot.body, { status: snapshot.healthy ? 200 : 503 })
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
