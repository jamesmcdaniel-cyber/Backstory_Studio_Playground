/**
 * /api/cron/adoption-rollup — daily recompute of the adoption rollups.
 *
 * Scheduled at 03:30 UTC, half an hour ahead of the 04:00 retention prune.
 * With a 90-day prune window and a two-week lookback the ordering has enormous
 * margin; the offset is insurance, not a dependency.
 *
 * `?weeks=N` recomputes N complete weeks instead of 2 — this doubles as the
 * one-time backfill over whatever live history exists after deploy.
 *
 * Auth (fail closed): requires Authorization: Bearer <CRON_SECRET>.
 */

import { timingSafeEqual } from 'crypto'
import { runAdoptionRollup } from '@/lib/adoption/compute'
import { apiLogger } from '@/lib/logger'
import { recordTokenRejection } from '@/lib/security/events'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

const DEFAULT_WEEKS = 2
const MAX_WEEKS = 104

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

  const requested = Number(new URL(request.url).searchParams.get('weeks'))
  const weeks = Math.min(
    MAX_WEEKS,
    Math.max(1, Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_WEEKS),
  )

  try {
    const result = await runAdoptionRollup(new Date(), weeks)
    apiLogger.info('adoption rollup complete', {
      weeks: result.weeks.length,
      organizations: result.organizations,
    })
    return Response.json({ success: true, ...result })
  } catch (error) {
    apiLogger.error('adoption rollup failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ success: false, error: 'Rollup failed' }, { status: 500 })
  }
}
