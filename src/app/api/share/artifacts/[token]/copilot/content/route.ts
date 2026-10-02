import { NextResponse, type NextRequest } from 'next/server'
import { rateLimit } from '@/lib/ratelimit'
import { clientIp } from '@/lib/security/events'
import { artifactPageResponse } from '@/lib/artifacts/serve'
import { guestCopyContent } from '@/lib/artifacts/templates'

export const runtime = 'nodejs'

// GET /api/share/artifacts/:token/copilot/content?copy=&v= — one version of a
// visitor's copy, served by the same function and sandbox as every artifact
// page. The frame that loads it is sandboxed to an opaque origin and may not
// carry the visitor's cookie, so the credential is the link's token plus the
// copy's own random id, which only its visitor was ever given.
export async function GET(request: NextRequest) {
  const limited = await rateLimit(`artifact-guest-content:${clientIp(request)}`, { limit: 120, windowMs: 60_000 })
  if (!limited.ok) return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  const token = request.nextUrl.pathname.split('/').at(-3) ?? ''
  const found = await guestCopyContent(token, request.nextUrl.searchParams.get('copy') ?? '', request.nextUrl.searchParams.get('v') ?? '')
  if (!found) return NextResponse.json({ error: 'This link is not available.' }, { status: 404 })
  return artifactPageResponse(found, request.nextUrl.origin)
}
