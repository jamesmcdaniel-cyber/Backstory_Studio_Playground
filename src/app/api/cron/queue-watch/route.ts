/**
 * /api/cron/queue-watch — periodic alerting over the queue plane's consumer
 * probe (src/lib/queue/consumer-probe.ts, the same one /api/health exposes).
 *
 * /api/health tells whoever is looking; this route makes sure someone is told
 * even when nobody is looking. See src/lib/queue/queue-watch.ts for the
 * decision logic (probe -> alertable? -> cooldown-gated notify) and
 * docs/runbooks/queue-incident.md "Automated watch" for what it checks, where
 * alerts land, and cooldown semantics.
 *
 * Auth (fail closed): same CRON_SECRET bearer-token convention as every other
 * route in src/app/api/cron/.
 */

import { timingSafeEqual } from 'crypto'
import { apiLogger } from '@/lib/logger'
import { recordTokenRejection } from '@/lib/security/events'
import { runQueueWatch } from '@/lib/queue/queue-watch'

export const runtime = 'nodejs'
export const maxDuration = 30
export const dynamic = 'force-dynamic'

async function checkAuthorized(request: Request): Promise<Response | null> {
  const secret = process.env.CRON_SECRET
  if (!secret) return Response.json({ success: false, error: 'CRON_SECRET not configured' }, { status: 503 })
  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  if (!(a.length === b.length && timingSafeEqual(a, b))) {
    await recordTokenRejection(request, { surface: 'cron', reason: 'invalid_cron_secret' })
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = await checkAuthorized(request)
  if (unauthorized) return unauthorized

  try {
    const result = await runQueueWatch()
    return Response.json({
      success: true,
      unhealthy: result.unhealthy,
      alerted: result.alerted,
      reason: result.reason ?? null,
    })
  } catch (error) {
    apiLogger.error('queue watch tick failed', { error: error instanceof Error ? error.message : String(error) })
    return Response.json({ success: false, error: 'queue watch tick failed' }, { status: 500 })
  }
}
