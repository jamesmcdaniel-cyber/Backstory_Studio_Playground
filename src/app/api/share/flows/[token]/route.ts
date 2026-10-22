import { NextResponse, type NextRequest } from 'next/server'
import { resolveAnonymousFlowShare } from '@/lib/flows/public-share'
import { clientIp } from '@/lib/security/events'

export const runtime = 'nodejs'

// GET /api/share/flows/:token — a flow's public link, for someone with no
// session: the sanitized read-only projection (public-graph.ts) and nothing
// else — no credentials, connection ids, run data or step outputs. The token
// is the only credential (192-bit, digest lookup, opt-in, expiring, rotatable)
// and lookups are rate limited per client.
export async function GET(request: NextRequest) {
  const token = request.nextUrl.pathname.split('/').at(-1) ?? ''
  const result = await resolveAnonymousFlowShare(token, { clientKey: clientIp(request) })
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
  if (result.status === 'rate_limited') return NextResponse.json({ error: 'Too many requests.' }, { status: 429, headers })
  if (result.status === 'expired') return NextResponse.json({ error: 'This link has expired.' }, { status: 410, headers })
  if (result.status !== 'ok') return NextResponse.json({ error: 'This link is not available.' }, { status: 404, headers })
  return NextResponse.json({ success: true, flow: result.flow }, { headers })
}
