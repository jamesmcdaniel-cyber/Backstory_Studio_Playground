import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { cachePing } from '@/lib/cache'
import { encryptionConfigured } from '@/lib/crypto/secrets'
import { neo4jPing } from '@/lib/rag/neo4j-store'
import { probeQueueConsumers } from '@/lib/queue/consumer-probe'
import { apiLogger } from '@/lib/logger'

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
          // Dispatch-tick freshness: a paused/deleted Vercel cron with no worker
          // plane stops every scheduled flow, and nothing else here would show it.
          ...('tick' in queueConsumers && queueConsumers.tick ? { tick: queueConsumers.tick } : {}),
        },
        secrets: { encrypted: encryptionConfigured() },
      },
    },
  }
}

/**
 * Whether this caller may see the detailed body.
 *
 * The `checks` block names queue topology, dead-letter counts, worker heartbeat
 * freshness and whether secret encryption is configured — a live infrastructure
 * map, and it used to be readable by anyone who knew the URL. Detail now needs
 * a token; liveness does not.
 *
 * Falls back to CRON_SECRET so existing uptime monitors that already carry it
 * keep their detailed view without new configuration. With neither variable set
 * (development, a fresh clone) detail is open, because there is no secret to
 * check against and nothing sensitive to protect.
 */
function detailAuthorized(request: Request): boolean {
  const secret = process.env.HEALTH_DETAIL_TOKEN || process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== 'production'
  const header = request.headers.get('authorization') || ''
  const provided = header.startsWith('Bearer ') ? header.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  const now = Date.now()
  const snapshot =
    lastProbe && now - lastProbe.at < PROBE_TTL_MS
      ? lastProbe.snapshot
      : await (inFlight ??= runProbes()
          .then((probed) => {
            lastProbe = { at: Date.now(), snapshot: probed }
            return probed
          })
          .finally(() => {
            inFlight = null
          }))

  const status = snapshot.healthy ? 200 : 503
  // The STATUS CODE is unchanged for everyone — an uptime monitor needs no
  // credential to learn up-or-down, which is the whole job of a liveness probe.
  // Only the body narrows.
  if (!detailAuthorized(request)) {
    return NextResponse.json({ status: snapshot.body.status, timestamp: snapshot.body.timestamp }, { status })
  }
  return NextResponse.json(snapshot.body, { status })
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
