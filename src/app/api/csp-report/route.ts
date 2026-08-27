import { NextResponse, type NextRequest } from 'next/server'
import { apiLogger } from '@/lib/logger'
import { rateLimit } from '@/lib/ratelimit'
import { readRequestTextLimited } from '@/lib/server/request-body'

/**
 * Collector for Content-Security-Policy violation reports.
 *
 * Report-only mode is the safe way to roll out the strict CSP, but it is only
 * useful if the reports land somewhere. Without this the rollout instruction was
 * "watch browser consoles", which sees whatever a developer happens to have open
 * and nothing a real user hits — the violations that matter most are the ones on
 * screens nobody is currently looking at.
 *
 * Deliberately unauthenticated: a browser posts these with no credentials, and a
 * violation can fire on a page whose session is exactly what broke. It is
 * therefore treated as untrusted, anonymous, attacker-reachable input — rate
 * limited per client, size capped, and never echoed back.
 *
 * Always returns 204. A collector that argues with the browser is a collector
 * that gets retried.
 */

export const runtime = 'nodejs'

/** Reports are small; anything larger is not a real one. */
const MAX_REPORT_BYTES = 16_000

/** Shape posted by `report-uri` (legacy) and `report-to` (modern) respectively. */
interface LegacyReport {
  'csp-report'?: Record<string, unknown>
}
interface ModernReport {
  type?: string
  body?: Record<string, unknown>
}

function clientKey(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || request.headers.get('x-real-ip') || 'unknown'
}

/** Pull the fields worth alerting on out of either report shape. */
function summarize(report: Record<string, unknown>) {
  const pick = (...names: string[]) => {
    for (const name of names) {
      const value = report[name]
      if (typeof value === 'string' && value) return value
    }
    return undefined
  }
  return {
    directive: pick('effective-directive', 'effectiveDirective', 'violated-directive', 'violatedDirective'),
    blockedUri: pick('blocked-uri', 'blockedURL'),
    documentUri: pick('document-uri', 'documentURL'),
    // The first ~100 chars of an inline script are enough to recognise which one
    // it is without logging a whole third-party bundle into the log store.
    sample: pick('script-sample', 'sample')?.slice(0, 100),
    disposition: pick('disposition'),
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  // Fail closed: an uncollected report costs a line of telemetry; an open,
  // unauthenticated, unbounded POST endpoint costs more.
  const limited = await rateLimit(`csp-report:${clientKey(request)}`, {
    limit: 30,
    windowMs: 60_000,
    failureMode: 'closed',
  })
  if (!limited.ok) return new NextResponse(null, { status: 204 })

  // Browsers send legacy reports as `application/csp-report`, which is JSON in
  // practice but intentionally is not an `application/json` media type. Read
  // bounded text here and parse it explicitly so the size guard does not break
  // the report-uri format while modern report-to JSON remains supported.
  const payload = await readRequestTextLimited(request, MAX_REPORT_BYTES)
    .then((body) => JSON.parse(body) as unknown)
    .catch(() => null)
  if (!payload) return new NextResponse(null, { status: 204 })

  // report-to sends an array of reports; report-uri sends a single object.
  const reports = Array.isArray(payload) ? payload : [payload]
  for (const entry of reports.slice(0, 10)) {
    if (!entry || typeof entry !== 'object') continue
    const body =
      (entry as LegacyReport)['csp-report'] ??
      (entry as ModernReport).body ??
      (entry as Record<string, unknown>)
    if (!body || typeof body !== 'object') continue

    const summary = summarize(body as Record<string, unknown>)
    if (!summary.directive && !summary.blockedUri) continue

    // warn, not error: during report-only rollout these are expected findings to
    // triage, not failures. Paging on them would train everyone to ignore them.
    apiLogger.warn('CSP violation reported', summary)
  }

  return new NextResponse(null, { status: 204 })
}
