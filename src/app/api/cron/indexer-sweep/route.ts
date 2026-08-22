/**
 * /api/cron/indexer-sweep — Vercel Cron handler
 *
 * Batches `ActivityEvent` rows with `indexedAt IS NULL` into the graph-RAG
 * store (200 per tick — see `src/lib/activity/indexer-sweep.ts`). Same
 * fail-closed CRON_SECRET auth as the other `/api/cron/*` routes; this file
 * is only auth plus response shaping, the tick body lives in the lib module.
 */

import { timingSafeEqual } from 'crypto'
import { apiLogger } from '@/lib/logger'
import { runIndexerSweep } from '@/lib/activity/indexer-sweep'
import { recordTokenRejection } from '@/lib/security/events'

export const runtime = 'nodejs'
export const maxDuration = 300
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
    const result = await runIndexerSweep()
    return Response.json({ success: true, ...result })
  } catch (error) {
    apiLogger.error('cron/indexer-sweep: unhandled error', { error: error instanceof Error ? error.message : String(error) })
    return Response.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
