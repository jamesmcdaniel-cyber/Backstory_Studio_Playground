/**
 * /api/cron/dispatch — Vercel Cron handler
 *
 * The tick's BODY lives in src/lib/scheduling/dispatch-tick.ts, because it now
 * has two callers: this route (the Vercel cron entry in vercel.json) and the
 * BullMQ worker's 60s timer. Both go through the same Redis lock, so running
 * them together is safe and either surviving alone keeps schedules firing. This
 * route is only auth plus response shaping.
 *
 * Auth (fail closed): CRON_SECRET env var MUST be set. If it is not configured
 * the handler returns 503. When set, requests must carry:
 *   Authorization: Bearer <CRON_SECRET>
 * compared in constant time. There is no header-only bypass in any environment.
 */

import { timingSafeEqual } from 'crypto'
import { apiLogger } from '@/lib/logger'
import { runDispatchTick } from '@/lib/scheduling/dispatch-tick'

export const runtime = 'nodejs'
export const maxDuration = 800
export const dynamic = 'force-dynamic'

/**
 * Fail-closed auth. CRON_SECRET must be configured; otherwise the handler is
 * unavailable. When set, the request must present a matching bearer token,
 * compared in constant time over equal-length buffers. No header-only bypass.
 *
 * Returns null when authorized, or a Response to short-circuit with.
 */
function checkAuthorized(request: Request): Response | null {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return Response.json(
      { success: false, error: 'CRON_SECRET not configured' },
      { status: 503 },
    )
  }

  const authHeader = request.headers.get('authorization') || ''
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''

  const a = Buffer.from(provided)
  const b = Buffer.from(secret)
  const authorized = a.length === b.length && timingSafeEqual(a, b)
  if (!authorized) {
    return Response.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

export async function GET(request: Request) {
  const unauthorized = checkAuthorized(request)
  if (unauthorized) return unauthorized

  try {
    return Response.json(await runDispatchTick())
  } catch (error) {
    apiLogger.error('cron/dispatch: unhandled error', {
      error: error instanceof Error ? error.message : String(error),
    })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
