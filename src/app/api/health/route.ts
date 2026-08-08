import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { cachePing } from '@/lib/cache'
import { encryptionConfigured } from '@/lib/crypto/secrets'
import { neo4jPing } from '@/lib/rag/neo4j-store'
import { probeQueueConsumers } from '@/lib/queue/consumer-probe'
import { apiLogger } from '@/lib/logger'
import { timingSafeEqual } from 'node:crypto'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Readiness probe. Postgres is always critical. Redis is also critical in
 * production because it owns global abuse limits and durable queue handoff;
 * Neo4j remains an optional best-effort RAG dependency.
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
  const [db, cache, neo4j, queueConsumers] = await Promise.all([
    probe(async () => { await prisma.$queryRaw`SELECT 1` }),
    cachePing().then((c) => ({ ok: c.ok, configured: c.configured })).catch(() => ({ ok: false, configured: false })),
    neo4jPing().catch(() => ({ ok: false, configured: false })),
    // Consumer side of the queue plane. Redis reachable ≠ Redis consumed: with
    // EXECUTION_MODE=queue and no worker registered (down, or listening on a
    // different Redis), every run is accepted into `waiting` and hangs forever
    // while this endpoint reports ok. Shipped exactly that way on 2026-08-04.
    probeQueueConsumers().catch(() => ({ configured: true, ok: false, stranded: [] })),
  ])
  if (queueConsumers.configured && !queueConsumers.ok) {
    apiLogger.error('queue consumer probe failed — runs will strand in waiting', {
      stranded: queueConsumers.stranded,
      error: 'error' in queueConsumers ? queueConsumers.error : undefined,
    })
  }
  const healthy =
    db.ok &&
    (process.env.NODE_ENV !== 'production' || (cache.configured && cache.ok)) &&
    (!queueConsumers.configured || queueConsumers.ok)
  return {
    healthy,
    body: {
      status: healthy ? 'ok' : 'unhealthy',
      timestamp: new Date().toISOString(),
      // queueConsumers.error (if any) stays server-side via the probe's own
      // shape — reports carry only queue names + counts, no topology.
      checks: {
        db,
        cache,
        neo4j,
        queueConsumers: {
          configured: queueConsumers.configured,
          ok: queueConsumers.ok,
          stranded: queueConsumers.stranded,
          ...('reports' in queueConsumers && queueConsumers.reports ? { queues: queueConsumers.reports } : {}),
          // Alertable extras for uptime monitors: dead-lettered jobs (any
          // total > 0 deserves eyes) and worker heartbeat freshness.
          ...('deadLetters' in queueConsumers && queueConsumers.deadLetters ? { deadLetters: queueConsumers.deadLetters } : {}),
          ...('heartbeat' in queueConsumers && queueConsumers.heartbeat ? { heartbeat: queueConsumers.heartbeat } : {}),
        },
        secrets: { encrypted: encryptionConfigured() },
      },
    },
  }
}

function detailedProbeAuthorized(request: Request): boolean {
  const expected = process.env.HEALTH_PROBE_SECRET
  if (!expected) return false
  const presented = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  const now = Date.now()
  if (lastProbe && now - lastProbe.at < PROBE_TTL_MS) {
    const body = detailedProbeAuthorized(request)
      ? lastProbe.snapshot.body
      : { status: lastProbe.snapshot.healthy ? 'ok' : 'unhealthy' }
    return NextResponse.json(body, { status: lastProbe.snapshot.healthy ? 200 : 503 })
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
  const body = detailedProbeAuthorized(request) ? snapshot.body : { status: snapshot.healthy ? 'ok' : 'unhealthy' }
  return NextResponse.json(body, { status: snapshot.healthy ? 200 : 503 })
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
